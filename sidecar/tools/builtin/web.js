/* sidecar/tools/builtin/web.js — the WEB capability: web_search(query) and web_fetch(url).
   Zero extra API keys for the MVP. Node 18+ (global fetch). No deps.

   makeWebTools(deps?) -> { searchTool, fetchTool, register(registry),
                            webSearch(query,opts), webFetch(url,opts) }   // raw fns exported for reuse/testing
     deps.fetchImpl  : (url, init) => Promise<Response>   // injectable for tests; defaults to global fetch
     deps.openrouter : { apiKey, model } | null           // enables the OpenRouter search/fetch FALLBACK
     deps.userAgent  : override UA string

   DESIGN (validated live, June 2026):
     web_search PRIMARY  = DuckDuckGo HTML endpoint (POST https://html.duckduckgo.com/html/), parsed to
                           [{title,url,snippet}]. Keyless. RISK: trips an "anomaly" 202 block after a few
                           rapid requests from one IP and stays blocked for minutes — so we (a) detect the
                           202/anomaly shell and treat it as a soft failure, (b) self-throttle, (c) fall back.
                  FALLBACK1 = DuckDuckGo lite endpoint (different markup, sometimes survives when html/ is blocked).
                  FALLBACK2 = OpenRouter web search server tool (needs the user's existing OpenRouter key; ~$0.005/call).
     web_fetch  PRIMARY  = Jina Reader (https://r.jina.ai/<url>) -> clean markdown/text. Keyless = 20 RPM.
                           Surfaces upstream errors INSIDE a 200 body ("Warning: Target URL returned error 404"),
                           so we scan the body, not just the status.
                  FALLBACK = direct fetch + HTML->text strip (works great for static/simple pages; no rate limit).

   SECURITY: web_fetch refuses non-http(s) and SSRF targets — loopback/RFC-1918/link-local/ULA/CGNAT,
   IPv6 private + IPv4-mapped, integer/hex IP encodings, and bare intranet names — for the requested
   host, every REDIRECT hop (followed manually + re-validated), and the address a name RESOLVES to
   (rebinding). All network calls are time-bounded. Output is truncated. No secrets are ever logged. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.tools = root.SK.tools || {}; (root.SK.tools.builtin = root.SK.tools.builtin || {}).web = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                     '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
  const FETCH_MAX_CHARS   = 6000;   // web_fetch truncation
  const SNIPPET_MAX_CHARS = 320;
  const SEARCH_TIMEOUT_MS = 12000;
  const FETCH_TIMEOUT_MS  = 15000;

  // ---------- small utilities ----------
  function withTimeout(promiseFactory, ms) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    return Promise.resolve(promiseFactory(ctrl.signal)).finally(() => clearTimeout(t));
  }
  function decodeEntities(s) {
    return String(s)
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, ' ')
      .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCharCode(+n); } catch (e) { return ' '; } });
  }
  function stripTags(s) { return decodeEntities(String(s).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim(); }
  function clamp(s, n) { s = String(s); return s.length > n ? s.slice(0, n).trimEnd() + ' …' : s; }

  // ---------- SSRF / URL guard for web_fetch ----------
  // The model picks the URL, so this guard is a real trust boundary: refuse loopback, RFC-1918,
  // link-local, ULA, CGNAT, IPv6 private/mapped, integer/hex IP encodings, and bare intranet names —
  // for IPv4, IPv6 (bracketed), and (when a resolver is wired) the address a name RESOLVES to.
  function isPrivateV4(h) {
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return false;
    const p = h.split('.').map(Number);
    if (p.some(n => n > 255)) return true;                       // malformed octet -> refuse
    const a = p[0], b = p[1];
    return a === 0 || a === 127 || a === 10 ||
      (a === 192 && b === 168) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 100 && b >= 64 && b <= 127);                        // CGNAT 100.64.0.0/10
  }
  function isPrivateV6(h) {
    h = String(h).toLowerCase();
    return h === '::1' || h === '::' ||
      /^::ffff:/.test(h) ||                                      // IPv4-mapped (Node renders 127.0.0.1 as ::ffff:7f00:1)
      /^fe[89ab][0-9a-f]:/.test(h) ||                            // fe80::/10 link-local
      /^f[cd][0-9a-f]{2}:/.test(h);                              // fc00::/7 unique-local
  }
  function hostOf(u) {
    let h = u.hostname.toLowerCase();
    if (h.charAt(0) === '[') h = h.slice(1, -1);                 // strip IPv6 brackets
    return h;
  }
  function assertSafeUrl(raw) {
    let u;
    try { u = new URL(raw); } catch (e) { throw new Error('invalid URL: ' + raw); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('only http(s) URLs are allowed');
    const h = hostOf(u);
    const blockedName =
      h === 'localhost' || h === '0.0.0.0' ||
      h === 'metadata.goog' || h.endsWith('.metadata.goog') ||                  // GCP cloud-metadata shorthand (metadata.google.internal already caught by .internal)
      h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') ||
      h.endsWith('.lan') || h.endsWith('.intranet') || h.endsWith('.home') || h.endsWith('.corp');
    const numericHost = /^\d+$/.test(h) || /^0x[0-9a-f]+$/i.test(h);   // integer / hex IP encodings (e.g. http://2130706433/)
    const bareName = h.indexOf('.') < 0 && h.indexOf(':') < 0 && !numericHost;  // single-label intranet name
    if (blockedName || bareName || numericHost || isPrivateV4(h) || isPrivateV6(h))
      throw new Error('refusing to fetch private/loopback/intranet host: ' + h);
    return u;
  }
  // DNS-rebinding guard: resolve a NAME and refuse if any address is private. Injectable + best-effort
  // (a resolution failure is left for the fetch to surface). IP literals are already checked statically.
  function nodeLookup(host) { const dns = require('node:dns'); return dns.promises.lookup(host, { all: true }); }
  async function assertResolvedSafe(u, lookup) {
    if (!lookup) return;
    const h = hostOf(u);
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.indexOf(':') >= 0) return;   // already a literal
    let addrs;
    try { addrs = await lookup(u.hostname); } catch (e) { return; }
    for (const a of (addrs || [])) {
      const ip = (a && a.address) || '';
      if (isPrivateV4(ip) || isPrivateV6(ip)) throw new Error('refusing: ' + u.hostname + ' resolves to private address ' + ip);
    }
  }

  // ---------- HTML -> readable text (web_fetch fallback) ----------
  function htmlToText(html) {
    let s = String(html);
    s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ')
         .replace(/<style[\s\S]*?<\/style>/gi, ' ')
         .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
         .replace(/<!--[\s\S]*?-->/g, ' ')
         .replace(/<\/(p|div|h[1-6]|li|tr|section|article|header|footer)>/gi, '\n')
         .replace(/<br\s*\/?>/gi, '\n')
         .replace(/<[^>]+>/g, ' ');
    s = decodeEntities(s)
         .replace(/[ \t\f\v]+/g, ' ')
         .replace(/ *\n */g, '\n')
         .replace(/\n{3,}/g, '\n\n')
         .trim();
    return s;
  }

  // ======================================================================
  //  web_search
  // ======================================================================

  // DuckDuckGo wraps result hrefs as /l/?uddg=<encoded-real-url>. Unwrap them.
  function unwrapDDG(href) {
    if (!href) return '';
    href = decodeEntities(href);
    if (href.startsWith('//')) href = 'https:' + href;
    try {
      const u = new URL(href, 'https://duckduckgo.com');
      const uddg = u.searchParams.get('uddg');
      if (uddg) return decodeURIComponent(uddg);
      return u.href;
    } catch (e) { return href; }
  }

  // True if the response is DDG's empty anti-bot shell (status 202 + "anomaly"/"challenge", no results).
  function isDDGBlocked(status, html) {
    const low = html.toLowerCase();
    return status === 202 || low.includes('anomaly') || (low.includes('challenge') && !low.includes('result__a'));
  }

  function parseDDGHtml(html) {
    const out = [];
    const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(html)) && out.length < 12) {
      const url = unwrapDDG(m[1]);
      const title = stripTags(m[2]);
      if (!url || !title) continue;
      // snippet lives just after the title link in a .result__snippet element
      const tail = html.slice(m.index, m.index + 2500);
      const sm = tail.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i) ||
                 tail.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(div|span|td)>/i);
      out.push({ title, url, snippet: sm ? clamp(stripTags(sm[1]), SNIPPET_MAX_CHARS) : '' });
    }
    return out;
  }

  // DDG lite endpoint has a flat <table> of <a class="result-link"> + a following snippet row.
  function parseDDGLite(html) {
    const out = [];
    const re = /<a[^>]*class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(html)) && out.length < 12) {
      const url = unwrapDDG(m[1]);
      const title = stripTags(m[2]);
      if (!url || !title) continue;
      const tail = html.slice(m.index, m.index + 2500);
      const sm = tail.match(/class="result-snippet"[^>]*>([\s\S]*?)<\/td>/i);
      out.push({ title, url, snippet: sm ? clamp(stripTags(sm[1]), SNIPPET_MAX_CHARS) : '' });
    }
    return out;
  }

  function makeWebTools(deps) {
    deps = deps || {};
    const doFetch = deps.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    if (!doFetch) throw new Error('web.js requires global fetch (Node 18+) or deps.fetchImpl');
    const UA = deps.userAgent || DEFAULT_UA;
    const or = deps.openrouter || null;
    // DNS-rebinding guard resolver: default to real Node DNS; pass deps.lookup:null to disable (tests).
    const doLookup = ('lookup' in deps) ? deps.lookup : nodeLookup;

    function searchHeaders(extra) {
      return Object.assign({
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9'
      }, extra || {});
    }

    async function ddgSearch(endpoint, parser, query) {
      const html = await withTimeout(signal => doFetch(endpoint, {
        method: 'POST',
        headers: searchHeaders({ 'Content-Type': 'application/x-www-form-urlencoded' }),
        body: 'q=' + encodeURIComponent(query) + '&kl=us-en',
        signal
      }).then(async r => ({ status: r.status, body: await r.text() })), SEARCH_TIMEOUT_MS);
      if (isDDGBlocked(html.status, html.body)) { const e = new Error('duckduckgo rate-limited (anomaly/202)'); e.__blocked = true; throw e; }
      return parser(html.body);
    }

    // FALLBACK2: OpenRouter web search server tool. Hides the search as one model turn, but very robust.
    async function openrouterSearch(query) {
      if (!or || !or.apiKey) throw new Error('no OpenRouter key for search fallback');
      const body = {
        model: or.model || 'openai/gpt-4o-mini',
        messages: [{ role: 'user', content:
          'Search the web for: ' + query + '\nReturn the top results as a numbered list, each line "Title — URL — one-sentence snippet".' }],
        tools: [{ type: 'openrouter:web_search', parameters: { engine: 'auto', max_results: 8 } }]
      };
      const data = await withTimeout(signal => doFetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + or.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal
      }).then(r => r.json()), SEARCH_TIMEOUT_MS + 8000);
      const msg = data && data.choices && data.choices[0] && data.choices[0].message;
      // Prefer structured url_citation annotations when present.
      const ann = (msg && msg.annotations) || [];
      const cites = ann.filter(a => a && a.type === 'url_citation' && a.url_citation)
                       .map(a => ({ title: a.url_citation.title || a.url_citation.url, url: a.url_citation.url,
                                    snippet: clamp(a.url_citation.content || '', SNIPPET_MAX_CHARS) }));
      if (cites.length) return cites;
      // else parse the model's plain-text list
      const text = (msg && msg.content) || '';
      return String(text).split('\n').map(l => {
        const mm = l.match(/^\s*\d+[.)]\s*(.+?)\s+[—-]\s+(https?:\/\/\S+)\s*[—-]?\s*(.*)$/);
        return mm ? { title: mm[1].trim(), url: mm[2].trim(), snippet: clamp(mm[3].trim(), SNIPPET_MAX_CHARS) } : null;
      }).filter(Boolean);
    }

    // PUBLIC: returns { results:[{title,url,snippet}], source } ; throws only if every path fails.
    async function webSearch(query, opts) {
      query = String(query || '').trim();
      if (!query) throw new Error('empty query');
      const errors = [];
      const chain = [
        ['duckduckgo-html', () => ddgSearch('https://html.duckduckgo.com/html/', parseDDGHtml, query)],
        ['duckduckgo-lite', () => ddgSearch('https://lite.duckduckgo.com/lite/', parseDDGLite, query)]
      ];
      if (or && or.apiKey) chain.push(['openrouter', () => openrouterSearch(query)]);
      for (const [source, fn] of chain) {
        try {
          const results = await fn();
          if (results && results.length) return { results: results.slice(0, (opts && opts.limit) || 8), source };
          errors.push(source + ': 0 results');
        } catch (e) { errors.push(source + ': ' + (e && e.message ? e.message : String(e))); }
      }
      const e = new Error('web_search failed (' + errors.join(' | ') + ')');
      e.__allFailed = true; throw e;
    }

    // ====================================================================
    //  web_fetch
    // ====================================================================

    // PRIMARY: Jina Reader. Keyless 20 RPM. Add deps.jinaKey later to raise to 500 RPM.
    async function jinaFetch(targetUrl) {
      const headers = { 'Accept': 'text/plain', 'X-Return-Format': 'text', 'User-Agent': UA };
      if (deps.jinaKey) headers['Authorization'] = 'Bearer ' + deps.jinaKey;
      const res = await withTimeout(signal => doFetch('https://r.jina.ai/' + targetUrl, { headers, signal })
        .then(async r => ({ status: r.status, body: await r.text() })), FETCH_TIMEOUT_MS);
      if (res.status === 401 || res.status === 402 || res.status === 429) {
        const e = new Error('jina ' + res.status); e.__retryDirect = true; throw e;
      }
      if (res.status >= 400) throw new Error('jina http ' + res.status);
      // Jina reports upstream failures inside a 200 body.
      if (/^Warning: Target URL returned error \d/m.test(res.body)) {
        const w = res.body.match(/Warning: Target URL returned error (\d+)[^\n]*/);
        const e = new Error('upstream ' + (w ? w[1] : 'error')); e.__retryDirect = true; throw e;
      }
      const body = res.body.replace(/^(Title:[^\n]*\n)?(URL Source:[^\n]*\n)?(Published Time:[^\n]*\n)?(Markdown Content:\n)?/i, '');
      return body.trim();
    }

    // FALLBACK: direct fetch + strip. No rate limit; great for static pages. Redirects are followed
    // MANUALLY so every hop is re-validated against the SSRF guard — a public page cannot bounce us
    // to an internal address (e.g. a 302 -> http://169.254.169.254/ cloud-metadata endpoint).
    async function directFetch(u0) {
      let u = u0;
      for (let hop = 0; hop < 6; hop++) {
        const res = await withTimeout(signal => doFetch(u.href, {
          headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml' }, redirect: 'manual', signal
        }).then(async r => ({ status: r.status, ct: r.headers.get('content-type') || '', loc: r.headers.get('location') || '', body: await r.text() })), FETCH_TIMEOUT_MS);
        if (res.status >= 300 && res.status < 400 && res.loc) {
          const next = assertSafeUrl(new URL(res.loc, u.href).href);   // re-validate the redirect target
          await assertResolvedSafe(next, doLookup);
          u = next; continue;
        }
        if (res.status >= 400) throw new Error('http ' + res.status);
        if (/application\/(json|xml)|text\/(plain|csv)/i.test(res.ct)) return res.body.trim();
        return htmlToText(res.body);
      }
      throw new Error('too many redirects');
    }

    // PUBLIC: returns { text, url, source }; throws only if both paths fail.
    async function webFetch(rawUrl, opts) {
      const u = assertSafeUrl(rawUrl);
      await assertResolvedSafe(u, doLookup);   // refuse names that RESOLVE to private addresses (rebinding)
      const max = (opts && opts.maxChars) || FETCH_MAX_CHARS;
      let text, source, jErr;
      try { text = await jinaFetch(u.href); source = 'jina'; }
      catch (e) { jErr = e; text = await directFetch(u); source = 'direct'; }
      if (!text || !text.trim()) {
        if (source === 'jina') { text = await directFetch(u); source = 'direct'; }
        if (!text || !text.trim()) throw new Error('web_fetch got empty content' + (jErr ? ' (jina: ' + jErr.message + ')' : ''));
      }
      return { text: clamp(text, max), url: u.href, source };
    }

    // ====================================================================
    //  Tool definitions (match sidecar/tools/tool.js shape)
    // ====================================================================
    const searchTool = {
      name: 'web_search', capability: 'web', scope: 'read', requiresConsent: false, timeoutMs: SEARCH_TIMEOUT_MS + 25000,
      description: 'Search the web and get a list of results (title, url, snippet). Use this to find current information and pages to read.',
      schema: { type: 'object', required: ['query'], properties: { query: { type: 'string' } } },
      run: async (args, ctx) => {
        // visible tool activity is the loop's frozen agent.tool_call / agent.tool_result events
        const { results, source } = await webSearch(args.query, {});
        const content = results.length
          ? results.map((r, i) => (i + 1) + '. ' + r.title + '\n   ' + r.url + (r.snippet ? '\n   ' + r.snippet : '')).join('\n')
          : 'No results.';
        return { content, summary: results.length + ' result(s) via ' + source };
      }
    };

    const fetchTool = {
      name: 'web_fetch', capability: 'web', scope: 'read', requiresConsent: false, timeoutMs: FETCH_TIMEOUT_MS + 20000,
      description: 'Fetch a web page by URL and return its main text content (cleaned). Use after web_search to read a result.',
      schema: { type: 'object', required: ['url'], properties: { url: { type: 'string' } } },
      run: async (args, ctx) => {
        const { text, url, source } = await webFetch(args.url, {});
        return { content: text, summary: text.length + ' chars via ' + source };
      }
    };

    return {
      searchTool, fetchTool, webSearch, webFetch,
      // exported for unit tests
      _internals: { parseDDGHtml, parseDDGLite, unwrapDDG, isDDGBlocked, htmlToText, assertSafeUrl, assertResolvedSafe, isPrivateV4, isPrivateV6 },
      register(reg) { reg.register(searchTool); reg.register(fetchTool); return reg; }
    };
  }

  return { makeWebTools };
});
