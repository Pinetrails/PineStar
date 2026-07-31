/* sidecar/tools/builtin/web.js — the WEB capability: web_search(query) and web_fetch(url).
   Zero extra API keys for the MVP. Node 18+ (global fetch). No deps.

   makeWebTools(deps?) -> { searchTool, fetchTool, register(registry),
                            webSearch(query,opts), webFetch(url,opts) }   // raw fns exported for reuse/testing
     deps.fetchImpl  : (url, init) => Promise<Response>   // injectable for tests; defaults to global fetch
     deps.openrouter : { apiKey, model } | null           // enables the OpenRouter search/fetch FALLBACK
     deps.userAgent  : override UA string

   DESIGN (re-validated live, June 2026):
     web_search PRIMARY  = Mojeek (GET https://www.mojeek.com/search?q=…), an independent keyless engine,
                           parsed to [{title,url,snippet}]. Chosen because DuckDuckGo's keyless HTML/lite
                           endpoints now return a 202 "anomaly" anti-bot shell on essentially EVERY request
                           (not just under rapid load), so the old DDG-only chain failed for every user — and
                           for ChatGPT/Codex users (no OpenRouter key) there was no fallback at all.
                  FALLBACK1 = DuckDuckGo HTML endpoint (POST https://html.duckduckgo.com/html/). Kept in case
                              DDG un-blocks; the 202/anomaly shell is detected and treated as a soft failure.
                  FALLBACK2 = DuckDuckGo lite endpoint (different markup, sometimes survives when html/ is blocked).
                  FALLBACK3 = OpenRouter web plugin (needs the user's existing OpenRouter key; ~$0.005/call).
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
  const api = factory(typeof require === 'function' ? require('../fence.js') : (root.SK && root.SK.fence));
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.tools = root.SK.tools || {}; (root.SK.tools.builtin = root.SK.tools.builtin || {}).web = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (fence) {
  'use strict';

  const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                     '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
  const FETCH_MAX_CHARS   = 6000;   // web_fetch truncation
  /* RAW-BODY CEILING, applied BEFORE anything parses the response.
     htmlToText is a chain of lazy `[\s\S]*?` replaces — quadratic in the input — and the clamp to
     FETCH_MAX_CHARS ran AFTER it. Measured on a page of repeated "<script>": 64KB -> 55ms, 256KB -> 880ms,
     1MB -> 14.3 SECONDS of synchronous event-loop freeze, and it grows from there. StarNet is one process,
     so that is the whole station stopped by a page the agent was asked to read — and web_fetch is
     read-only, no-consent, callable on any URL including one suggested by untrusted content.
     2MB leaves the extractor far more material than the 6k it will keep, while bounding the worst case to
     well under a second. */
  const RAW_BODY_MAX_CHARS = 2 * 1024 * 1024;
  function readBodyBounded(r) {
    return Promise.resolve(r.text()).then(t => {
      const s = String(t == null ? '' : t);
      return s.length > RAW_BODY_MAX_CHARS ? s.slice(0, RAW_BODY_MAX_CHARS) : s;
    });
  }
  const SNIPPET_MAX_CHARS = 320;
  const SEARCH_TIMEOUT_MS = 12000;
  const FETCH_TIMEOUT_MS  = 15000;
  const OPENROUTER_SEARCH_TIMEOUT_MS = SEARCH_TIMEOUT_MS + 8000;

  // ---------- untrusted-content fence ----------
  // Page text and search snippets are attacker-authored input that lands directly in the agent's
  // context (the highest-volume untrusted input in the harness). Fence every web tool result in
  // explicit BEGIN/END markers with a data-not-instructions notice, and scrub any literal END
  // marker from the content so a hostile page cannot close the fence early and smuggle
  // "instructions" outside it. The fence is host-authored transcript framing, not model output.
  // MOVED to sidecar/tools/fence.js (2026-07-25) so browser page reads and MCP connector results — the two
  // untrusted sources that were arriving RAW — share this exact marker pair and scrub. A second copy would
  // drift, and a drifted scrub string is a fence a hostile page can close. Behavior here is unchanged.
  const FENCE_END = fence.FENCE_END;
  const fenceExternal = fence.fenceExternal;

  // ---------- small utilities ----------
  // Abort the fetch when EITHER our own timeout fires OR the parent run signal aborts (a tool-timeout in the
  // registry, or the run being cancelled). Chaining the parent means a cancelled/timed-out web_* call actually
  // drops its in-flight HTTP request instead of running to completion in the background.
  function withTimeout(promiseFactory, ms, parent) {
    const ctrl = new AbortController();
    let timedOut = false;
    const t = setTimeout(() => {
      timedOut = true;
      const reason = new Error('request timed out after ' + ms + 'ms');
      reason.__timeout = true;
      try { ctrl.abort(reason); } catch (_) { ctrl.abort(); }
    }, ms);
    if (parent) {
      if (parent.aborted) { try { ctrl.abort(parent.reason); } catch (_) { ctrl.abort(); } }
      else { try { parent.addEventListener('abort', () => { try { ctrl.abort(parent.reason); } catch (_) { ctrl.abort(); } }, { once: true }); } catch (_) {} }
    }
    return Promise.resolve(promiseFactory(ctrl.signal)).catch(e => {
      // Node/undici often discards AbortController.reason and reports only "This operation was aborted".
      // Preserve the distinction between our per-provider expiry and a parent run/tool cancellation so the
      // model can change source instead of blindly retrying an opaque abort.
      if (timedOut) {
        const reason = new Error('request timed out after ' + ms + 'ms');
        reason.__timeout = true;
        throw reason;
      }
      throw e;
    }).finally(() => clearTimeout(t));
  }
  function decodeEntities(s) {
    return String(s)
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, ' ')
      .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCharCode(+n); } catch (e) { return ' '; } });
  }
  function stripTags(s) { return decodeEntities(String(s).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim(); }
  function clamp(s, n) { s = String(s); return s.length > n ? s.slice(0, n).trimEnd() + ' …' : s; }

  function waitAbortable(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) { reject(signal.reason || new Error('request aborted')); return; }
      const timer = setTimeout(resolve, Math.max(0, Number(ms) || 0));
      if (signal) signal.addEventListener('abort', () => {
        clearTimeout(timer); reject(signal.reason || new Error('request aborted'));
      }, { once: true });
    });
  }

  /* Process-owned per-host politeness. `run` serializes only matching hosts, spaces requests after
     the first, and remembers bounded server backoff across agent runs. It never retries a request:
     the caller still sees the original 403/429/503 and chooses another source. */
  function makePoliteScheduler(deps) {
    deps = deps || {};
    const minGapMs = Math.max(0, Number(deps.minGapMs == null ? 350 : deps.minGapMs));
    const initialBackoffMs = Math.max(minGapMs, Number(deps.initialBackoffMs == null ? 1200 : deps.initialBackoffMs));
    const maxBackoffMs = Math.max(initialBackoffMs, Number(deps.maxBackoffMs == null ? 30000 : deps.maxBackoffMs));
    const wait = typeof deps.wait === 'function' ? deps.wait : waitAbortable;
    const hosts = new Map();

    function stateFor(host) {
      let state = hosts.get(host);
      if (!state) {
        state = { tail: Promise.resolve(), seen: false, backoffMs: 0, requests: 0, lastDelayMs: 0, lastStatus: 0 };
        hosts.set(host, state);
      }
      return state;
    }
    function retryAfterMs(response) {
      try {
        const raw = response && response.headers && response.headers.get('retry-after');
        if (!/^\s*\d+(?:\.\d+)?\s*$/.test(String(raw || ''))) return 0;
        return Math.min(maxBackoffMs, Math.max(0, Math.round(Number(raw) * 1000)));
      } catch (_) { return 0; }
    }
    function note(state, response) {
      const status = Number(response && response.status) || 0;
      state.lastStatus = status;
      if (status === 403 || status === 429 || status === 503) {
        const directed = retryAfterMs(response);
        state.backoffMs = directed || Math.min(maxBackoffMs, state.backoffMs ? state.backoffMs * 2 : initialBackoffMs);
      } else if (status >= 200 && status < 400) {
        state.backoffMs = 0;
      }
    }
    async function run(url, signal, request) {
      let host = '';
      try { host = hostOf(new URL(String(url))); } catch (_) { return request(); }
      const state = stateFor(host);
      const previous = state.tail;
      let release;
      state.tail = new Promise(resolve => { release = resolve; });
      try {
        await previous;
        const delayMs = state.seen ? Math.max(minGapMs, state.backoffMs) : 0;
        state.lastDelayMs = delayMs;
        if (delayMs) await wait(delayMs, signal);
        state.seen = true; state.requests++;
        const response = await request();
        note(state, response);
        return response;
      } finally { release(); }
    }
    function snapshot() {
      return Array.from(hosts.entries()).map(([host, state]) => ({
        host, requests: state.requests, backoffMs: state.backoffMs,
        lastDelayMs: state.lastDelayMs, lastStatus: state.lastStatus
      }));
    }
    return { run, snapshot };
  }

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
    // ...and the FQDN root label. WHATWG strips a trailing dot for IP literals but NOT for names, so
    // `localhost.` / `svc.internal.` / `wiki.` kept theirs and slipped past every name rule below. The DNS
    // guard would usually catch it downstream, but it is best-effort (a failed lookup returns silently, and
    // deps.lookup:null disables it), so the static rule must be right on its own. Same fix as browser.js.
    else h = h.replace(/\.+$/, '');
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
  /* HTML -> readable text, in ONE LINEAR PASS.
     This used to be a chain of lazy `[\s\S]*?` replaces, every one of them QUADRATIC on input the fetch
     does not control. `<script` with no `</script>` makes the lazy scan walk to end-of-input from each of
     the N start positions; `<[^>]+>` does the same on a run of `<`. Measured on a page of repeated
     "<script>": 64KB -> 55ms, 256KB -> 880ms, 1MB -> 14.3 SECONDS of synchronous event-loop freeze — the
     whole station (UI, API, SSE bus, every agent run) stopped by a page an agent was asked to read, on a
     read-only no-consent tool. Capping the input alone only moved the number; the scan itself had to stop
     being quadratic.
     An indexOf-driven walk is O(n) and output-equivalent for well-formed HTML: skip the contents of
     script/style/noscript and comments, turn block-closers and <br> into newlines, and drop every other tag.
     An UNCLOSED block or tag consumes the rest of the input exactly as the lazy regex did. */
  const BLOCK_CLOSERS = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'tr', 'section', 'article', 'header', 'footer']);
  const SKIP_BLOCKS = new Set(['script', 'style', 'noscript']);
  function stripMarkup(html) {
    const s = String(html);
    const out = [];
    let i = 0;
    while (i < s.length) {
      const lt = s.indexOf('<', i);
      if (lt < 0) { out.push(s.slice(i)); break; }
      if (lt > i) out.push(s.slice(i, lt));
      if (s.startsWith('<!--', lt)) {                                  // comment: skip to the terminator
        const end = s.indexOf('-->', lt + 4);
        out.push(' ');
        if (end < 0) break;
        i = end + 3; continue;
      }
      const gt = s.indexOf('>', lt + 1);
      if (gt < 0) { out.push(' '); break; }                            // unterminated tag consumes the rest
      const inner = s.slice(lt + 1, gt);
      const m = /^\/?\s*([a-zA-Z][a-zA-Z0-9]*)/.exec(inner);
      const name = m ? m[1].toLowerCase() : '';
      const closing = inner.charAt(0) === '/';
      if (!closing && SKIP_BLOCKS.has(name)) {                         // skip the whole block's contents
        const close = s.toLowerCase().indexOf('</' + name, gt + 1);
        out.push(' ');
        if (close < 0) break;                                          // unclosed block consumes the rest
        const closeGt = s.indexOf('>', close);
        i = closeGt < 0 ? s.length : closeGt + 1; continue;
      }
      if (name === 'br' || (closing && BLOCK_CLOSERS.has(name))) out.push('\n');
      else out.push(' ');
      i = gt + 1;
    }
    return out.join('');
  }
  function htmlToText(html) {
    return decodeEntities(stripMarkup(html))
      .replace(/[ \t\f\v]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
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

  /* The anchor-text capture is BOUNDED. `([\s\S]*?)</a>` scans to end-of-input from every start position
     when the closing tag is absent, so a search-engine body with many result-link OPENS and no closers is
     quadratic: measured 1MB -> 1403ms of frozen event loop on this single-process host. A result TITLE is a
     few dozen characters; 600 is already absurdly generous, and it turns each failed attempt into a fixed
     cost instead of a full scan. (The snippet lookups were already windowed to a 2500-char tail.) */
  function parseDDGHtml(html) {
    const out = [];
    const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]{0,600}?)<\/a>/gi;
    let m;
    while ((m = re.exec(html)) && out.length < 12) {
      const url = unwrapDDG(m[1]);
      const title = stripTags(m[2]);
      if (!url || !title) continue;
      // snippet lives just after the title link in a .result__snippet element
      const tail = html.slice(m.index, m.index + 2500);
      const sm = tail.match(/class="result__snippet"[^>]*>([\s\S]{0,1200}?)<\/a>/i) ||
                 tail.match(/class="result__snippet"[^>]*>([\s\S]{0,1200}?)<\/(div|span|td)>/i);
      out.push({ title, url, snippet: sm ? clamp(stripTags(sm[1]), SNIPPET_MAX_CHARS) : '' });
    }
    return out;
  }

  // DDG lite endpoint has a flat <table> of <a class="result-link"> + a following snippet row.
  function parseDDGLite(html) {
    const out = [];
    const re = /<a[^>]*class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]{0,600}?)<\/a>/gi;
    let m;
    while ((m = re.exec(html)) && out.length < 12) {
      const url = unwrapDDG(m[1]);
      const title = stripTags(m[2]);
      if (!url || !title) continue;
      const tail = html.slice(m.index, m.index + 2500);
      const sm = tail.match(/class="result-snippet"[^>]*>([\s\S]{0,1200}?)<\/td>/i);
      out.push({ title, url, snippet: sm ? clamp(stripTags(sm[1]), SNIPPET_MAX_CHARS) : '' });
    }
    return out;
  }

  // Mojeek: each result is <li> ... <a class="title" href="<real-url>">Title</a> ... <p class="s">snippet</p>.
  // Unlike DDG the href is the REAL destination (no /l/?uddg= redirect wrapper), so no unwrap is needed.
  function parseMojeek(html) {
    const out = [];
    const re = /<a[^>]*class="title"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(html)) && out.length < 12) {
      const url = decodeEntities(m[1]);
      const title = stripTags(m[2]);
      if (!url || !/^https?:\/\//i.test(url) || !title) continue;
      // snippet lives in the <p class="s"> just after the title link
      const tail = html.slice(m.index, m.index + 3000);
      const sm = tail.match(/<p[^>]*class="s"[^>]*>([\s\S]*?)<\/p>/i);
      out.push({ title, url, snippet: sm ? clamp(stripTags(sm[1]), SNIPPET_MAX_CHARS) : '' });
    }
    return out;
  }

  function makeWebTools(deps) {
    deps = deps || {};
    const rawFetch = deps.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    if (!rawFetch) throw new Error('web.js requires global fetch (Node 18+) or deps.fetchImpl');
    const politeness = deps.politeness || makePoliteScheduler({
      wait: deps.politeWait, minGapMs: deps.politeMinGapMs,
      initialBackoffMs: deps.politeInitialBackoffMs, maxBackoffMs: deps.politeMaxBackoffMs
    });
    const doFetch = (url, opts) => politeness.run(url, opts && opts.signal, () => rawFetch(url, opts));
    const UA = deps.userAgent || DEFAULT_UA;
    const or = deps.openrouter || null;
    // DNS-rebinding guard resolver: default to real Node DNS; pass deps.lookup:null to disable (tests).
    const doLookup = ('lookup' in deps) ? deps.lookup : nodeLookup;
    // web_request needs the RUN's surface (host authority — never taken from tool args) and a resolver for
    // the Commander's stored keys. Default: no keys and the strict surface, so an unwired caller can only
    // make UNAUTHENTICATED requests rather than silently gaining credentials it was never handed.
    const surface = deps.surface === 'interactive' ? 'interactive' : 'autonomous';
    // The station READER (webreader.js): a shared headless cookie-less real Chrome that fetch/search
    // borrow when plain HTTP hits a bot wall or every engine throttles. Optional — absent, everything
    // behaves exactly as before. Availability is probed lazily per use (Chrome may not exist).
    const reader = deps.reader || null;
    const readerReady = () => { try { return !!(reader && reader.available().ok); } catch (_) { return false; } };
    const serviceKeys = {
      resolve: (name, sfc) => (typeof deps.resolveServiceKey === 'function'
        ? deps.resolveServiceKey(name, sfc)
        : { ok: false, reason: 'unknown' })
    };

    function searchHeaders(extra) {
      return Object.assign({
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9'
      }, extra || {});
    }

    async function ddgSearch(endpoint, parser, query, parent) {
      const html = await withTimeout(signal => doFetch(endpoint, {
        method: 'POST',
        headers: searchHeaders({ 'Content-Type': 'application/x-www-form-urlencoded' }),
        body: 'q=' + formEncode(query) + '&kl=us-en',   // form-urlencoded: spaces are `+` (see the Mojeek law below)
        signal
      }).then(async r => ({ status: r.status, body: await readBodyBounded(r) })), SEARCH_TIMEOUT_MS, parent);
      if (isDDGBlocked(html.status, html.body)) { const e = new Error('duckduckgo rate-limited (anomaly/202)'); e.__blocked = true; throw e; }
      return parser(html.body);
    }

    // PRIMARY: Mojeek — keyless GET, independent index, no aggressive bot-shell. Treat a non-200 (e.g. a
    // 403/429 throttle) as a soft failure so the chain falls through to DDG/OpenRouter.
    /* ⛔ SPACES MUST BE `+`, NOT `%20` (live A/B, 2026-07-31): for a `%20`-encoded multi-word query
       Mojeek answers 200 with a ~5.7KB "Please…" interstitial and ZERO result anchors; the identical
       query `+`-encoded answers the real 20KB result page. encodeURIComponent produces %20, so every
       multi-word search silently got the shell — the field's endless "mojeek: 0 results". Form-style
       encoding is what a real browser submits for a query string, and it is what Mojeek expects. */
    const formEncode = (q) => encodeURIComponent(q).replace(/%20/g, '+');
    async function mojeekSearch(query, parent) {
      const res = await withTimeout(signal => doFetch('https://www.mojeek.com/search?q=' + formEncode(query), {
        method: 'GET', headers: searchHeaders(), signal
      }).then(async r => ({ status: r.status, body: await readBodyBounded(r) })), SEARCH_TIMEOUT_MS, parent);
      if (res.status !== 200) throw new Error('mojeek http ' + res.status);
      return parseMojeek(res.body);
    }

    // FALLBACK3: OpenRouter web plugin. Hides the search as one model turn, but very robust. Enabled via the
    // `plugins:[{id:'web'}]` request field (NOT a tools entry) — results come back as message.annotations of
    // type 'url_citation', which we read below.
    async function openrouterSearch(query, parent) {
      if (!or || !or.apiKey) throw new Error('no OpenRouter key for search fallback');
      const body = {
        model: or.model || 'openai/gpt-4o-mini',
        messages: [{ role: 'user', content:
          'Search the web for: ' + query + '\nReturn the top results as a numbered list, each line "Title — URL — one-sentence snippet".' }],
        plugins: [{ id: 'web', max_results: 8 }]
      };
      const data = await withTimeout(signal => doFetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + or.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal
      }).then(r => r.json()), OPENROUTER_SEARCH_TIMEOUT_MS, parent);
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
      const parent = opts && opts.signal;   // the run/tool-timeout signal, threaded down so a cancel drops the fetch
      const errors = [];
      const chain = [
        ['mojeek',          () => mojeekSearch(query, parent)],
        ['duckduckgo-html', () => ddgSearch('https://html.duckduckgo.com/html/', parseDDGHtml, query, parent)],
        ['duckduckgo-lite', () => ddgSearch('https://lite.duckduckgo.com/lite/', parseDDGLite, query, parent)]
      ];
      // The READER outranks the paid fallback: a real local Chrome sails past the fingerprint checks
      // that throttle the scrape endpoints, costs nothing, and keeps search working with zero keys.
      if (readerReady()) chain.push(['browser', async () => {
        const r = await reader.search(query, { signal: parent });
        return (r && r.results) || [];
      }]);
      if (or && or.apiKey) chain.push(['openrouter', () => openrouterSearch(query, parent)]);
      for (const [source, fn] of chain) {
        try {
          const results = await fn();
          if (results && results.length) return { results: results.slice(0, (opts && opts.limit) || 8), source };
          errors.push(source + ': 0 results');
        } catch (e) { errors.push(source + ': ' + (e && e.message ? e.message : String(e))); }
      }
      const e = new Error('web_search failed (' + errors.join(' | ')
        + '). Search providers are temporarily unavailable; do not immediately repeat the same search. '
        + 'Use sources already returned, try a known direct URL with web_fetch, or finish with an explicit evidence limitation.');
      e.__allFailed = true; e.__errors = errors.slice(); throw e;
    }

    // ====================================================================
    //  web_fetch
    // ====================================================================

    /* Jina Reader — clean text extraction, but KEYED. Its keyless tier is gone: as of 2026-07-25 every
       r.jina.ai request without a token returns 401 AuthenticationRequiredError (verified against
       example.com, Wikipedia and a vendor docs site — it is not a rate limit, it is auth). The old comment
       here still promised "keyless 20 RPM", so every web_fetch spent a doomed round-trip on Jina before
       silently falling back to directFetch. That is why fetch quality quietly degraded for everyone: the
       fallback returns our own cruder htmlToText, and anti-bot sites refuse it outright.
       Now: only attempted when a key is actually configured (deps.jinaKey, wired from the KEYS store), so a
       user with no Jina key goes straight to direct with no wasted hop, and a user WITH one gets the good
       extraction back. Either way the caller still falls back, so this can never be a hard failure. */
    async function jinaFetch(targetUrl, parent) {
      if (!deps.jinaKey) { const e = new Error('jina not configured'); e.__retryDirect = true; throw e; }
      const headers = { 'Accept': 'text/plain', 'X-Return-Format': 'text', 'User-Agent': UA };
      if (deps.jinaKey) headers['Authorization'] = 'Bearer ' + deps.jinaKey;
      const res = await withTimeout(signal => doFetch('https://r.jina.ai/' + targetUrl, { headers, signal })
        .then(async r => ({ status: r.status, body: await readBodyBounded(r) })), FETCH_TIMEOUT_MS, parent);
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
    async function directFetch(u0, parent) {
      let u = u0;
      for (let hop = 0; hop < 6; hop++) {
        const res = await withTimeout(signal => doFetch(u.href, {
          headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml' }, redirect: 'manual', signal
        }).then(async r => ({ status: r.status, ct: r.headers.get('content-type') || '', loc: r.headers.get('location') || '', body: await readBodyBounded(r) })), FETCH_TIMEOUT_MS, parent);
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
      const parent = opts && opts.signal;   // run/tool-timeout signal, threaded down so a cancel drops the fetch
      let text, source, jErr;
      try { text = await jinaFetch(u.href, parent); source = 'jina'; }
      catch (e) { jErr = e; text = await directFetch(u, parent); source = 'direct'; }
      if (!text || !text.trim()) {
        if (source === 'jina') { text = await directFetch(u, parent); source = 'direct'; }
        if (!text || !text.trim()) throw new Error('web_fetch got empty content' + (jErr ? ' (jina: ' + jErr.message + ')' : ''));
      }
      return { text: clamp(text, max), url: u.href, source };
    }

    // ====================================================================
    //  Tool definitions (match sidecar/tools/tool.js shape)
    // ====================================================================
    /* ---------- web weather is an ANSWER, not an error ----------
       Field data (2026-07-31, the Commander's own live workspace): the single biggest source of
       mid-run "errors" users see is this file throwing on ordinary web reality — bot-blocked sites
       (http 403), dead links (http 404), throttled keyless engines. Each throw became
       "ERROR: tool web_fetch failed: http 403" in the transcript and a red ✗ chip in COMMS, and a
       research task would rack up dozens — reading as a malfunctioning agent when nothing was wrong.
       Reference harnesses (Hermes) return these to the MODEL as plain data and show the user nothing.

       So: when the web ANSWERED — with a refusal, a 404, a throttle — the tool SUCCEEDED at finding
       that out. Return an ok result whose content states the fact and steers the model to a different
       source (never a blind retry). Genuine faults (timeouts, aborts, SSRF refusals, invalid URLs,
       unreachable network) still throw and still become isError results — those keep the loop-guard
       and repeat protection. Truthful telemetry cuts both ways: asserting a FAILURE the harness
       didn't have is as untruthful as hiding one. */
    function softFetchAnswer(e, rawUrl) {
      const msg = String((e && e.message) || '');
      const url = String(rawUrl || '');
      let host = url; try { host = new URL(url).hostname; } catch (_) {}
      const m = msg.match(/^http (\d{3})$/);
      if (m) {
        const s = +m[1];
        if (s === 404 || s === 410) return {
          content: 'No page exists at ' + url + ' (HTTP ' + s + ') — the link is dead or the content moved. ' +
                   'Do not refetch this exact URL; search for where it lives now, or use another source.',
          summary: 'dead link (' + s + ')'
        };
        if (s === 429) return {
          content: host + ' is rate-limiting automated readers right now (HTTP 429). ' +
                   'Use a different source for this information; the URL may work again later.',
          summary: 'rate-limited (429)'
        };
        if (s >= 500) return {
          content: host + '\'s own server is failing right now (HTTP ' + s + ') — an outage on their side. ' +
                   'Use a different source, or retry this URL later.',
          summary: 'site outage (' + s + ')'
        };
        return {
          content: host + ' declined automated access to ' + url + ' (HTTP ' + s + ') — bot protection or a ' +
                   'login wall. This page cannot be read directly; get the same information from a different ' +
                   'source instead of retrying.',
          summary: 'site declined (' + s + ')'
        };
      }
      if (msg === 'too many redirects') return {
        content: 'The URL ' + url + ' redirect-loops (6+ hops) and never lands on a page. Treat it as ' +
                 'unreachable and use a different source.',
        summary: 'redirect loop'
      };
      if (/^web_fetch got empty content/.test(msg)) return {
        content: 'The page at ' + url + ' loaded but yielded no readable text — it likely renders entirely ' +
                 'with JavaScript. Use the browser tool if one is available, or a different source.',
        summary: 'no readable text'
      };
      // getaddrinfo ENOTFOUND — the DOMAIN does not resolve: a dead site or a mistyped host, i.e. an answer.
      // (EAI_AGAIN / ECONNREFUSED / resets stay hard errors: they can also mean the USER'S network is down,
      // and calling that "web weather" would be the harness lying about its own connectivity.)
      const cause = e && e.cause;
      const causeCodes = cause ? [cause.code].concat((cause.errors || []).map(x => x && x.code)) : [];
      if (causeCodes.indexOf('ENOTFOUND') >= 0) return {
        content: 'The domain ' + host + ' does not resolve — the site no longer exists or the hostname is ' +
                 'mistyped. Do not retry this URL; search for the right address or use another source.',
        summary: 'domain not found'
      };
      return null;
    }
    /* The providers above are sequential fallbacks. The registry timeout must cover their SUM, not one
       provider plus a guess. The old 37s wrapper could abort OpenRouter before its own 20s allowance after
       Mojeek + both DDG paths had consumed time — exactly when the fallback was most needed. */
    const searchChainTimeoutMs = (SEARCH_TIMEOUT_MS * 3)
      + (reader ? 45000 : 0)   // the reader rung: Chrome boot + up to two engine navigations
      + ((or && or.apiKey) ? OPENROUTER_SEARCH_TIMEOUT_MS : 0)
      + 5000;
    const searchTool = {
      name: 'web_search', capability: 'web', scope: 'read', requiresConsent: false, timeoutMs: searchChainTimeoutMs,
      description: 'Search the web and get a list of results (title, url, snippet). Use this to find current information and pages to read. ' +
        'If every engine is throttled the result says so — that is temporary web weather, not a malfunction; change strategy instead of repeating the search.',
      schema: { type: 'object', required: ['query'], properties: { query: { type: 'string' } } },
      run: async (args, ctx) => {
        // visible tool activity is the loop's frozen agent.tool_call / agent.tool_result events
        let results, source;
        try { ({ results, source } = await webSearch(args.query, { signal: ctx && ctx.signal })); }
        catch (e) {
          // An exhausted keyless chain is the engines' weather, not a harness fault — answer it as
          // information (see softFetchAnswer's rationale above). webSearch itself still throws, so
          // programmatic callers and tests keep the strict contract.
          if (e && e.__allFailed) return {
            content: 'No results this time — every search engine declined (' + (e.__errors || []).join('; ') + '). ' +
                     'This is temporary throttling of the keyless engines, not a malfunction. Do not immediately ' +
                     'repeat the same search: use sources already gathered, web_fetch a known URL directly, or ' +
                     'finish and state the evidence limitation.',
            summary: 'engines throttled — no results'
          };
          throw e;
        }
        const content = results.length
          ? fenceExternal(
              results.map((r, i) => (i + 1) + '. ' + r.title + '\n   ' + r.url + (r.snippet ? '\n   ' + r.snippet : '')).join('\n'),
              'search results (titles/snippets are third-party text)')
          : 'No results.';
        return { content, summary: results.length + ' result(s) via ' + source };
      }
    };

    const fetchTool = {
      name: 'web_fetch', capability: 'web', scope: 'read', requiresConsent: false,
      timeoutMs: FETCH_TIMEOUT_MS + 20000 + (reader ? 45000 : 0),   // the reader rung needs Chrome boot + nav + settle
      description: 'Fetch a web page by URL and return its main text content (cleaned). Use after web_search to read a result. ' +
        'Bot-blocked and JavaScript-only pages are automatically retried through the station\'s own browser, so one call is enough. ' +
        'If a page still cannot be read (dead link, site outage, verification wall) the result says so — that is information about the site, not a tool failure; use a different source rather than retrying the same URL.',
      schema: { type: 'object', required: ['url'], properties: { url: { type: 'string' } } },
      run: async (args, ctx) => {
        let out;
        try { out = await webFetch(args.url, { signal: ctx && ctx.signal }); }
        catch (e) {
          /* THE READER RUNG — a wall a REAL browser can climb: bot-block statuses, challenge-prone
             503s, and JS-only pages. Dead links (404/410), genuine outages (500/502/504) and network
             faults skip it — Chrome cannot resurrect a page that does not exist, and a cold boot is
             not free. On success the label SAYS the browser read it (truthful provenance). */
          const msg = String((e && e.message) || '');
          const m = msg.match(/^http (\d{3})$/);
          const s = m ? +m[1] : 0;
          const walled = s === 401 || s === 403 || s === 407 || s === 429 || s === 451 || s === 503
            || /^web_fetch got empty content/.test(msg);
          if (walled && readerReady()) {
            const r = await reader.fetchText(args.url, { signal: ctx && ctx.signal });
            if (r && r.ok) {
              const text = clamp(r.text, FETCH_MAX_CHARS);
              return {
                content: fenceExternal(text, 'page text from ' + (r.url || args.url) + ' (read via the station browser' + (s ? ' after http ' + s : '') + ')'),
                summary: text.length + ' chars via browser'
              };
            }
            const soft2 = softFetchAnswer(e, args.url);
            if (soft2) return {
              content: soft2.content + ' (The station\'s own browser also tried and was refused'
                + (r && r.reason === 'challenge' ? ' — the site is holding a verification wall' : '') + '.)',
              summary: soft2.summary
            };
          }
          const soft = softFetchAnswer(e, args.url);   // the web ANSWERED (403/404/throttle/…) → ok result
          if (soft) return soft;
          throw e;                                     // genuine fault (timeout/abort/SSRF/bad URL) → isError
        }
        return { content: fenceExternal(out.text, 'page text from ' + out.url), summary: out.text.length + ' chars via ' + out.source };
      }
    };

    /* ---------- web_request: call a third-party REST API with the Commander's key ----------
       WHY THIS EXISTS: before it, nothing in StarNet could send a custom header. web_fetch's whole schema
       is {url}, so ANY authenticated API meant handing the agent a full shell (shell.exec + curl), which
       needs a placed workbench and is a far larger grant than "make one HTTPS call". This tool is the
       narrow capability that job actually needs.

       THE SECRET NEVER ENTERS MODEL CONTEXT. The model writes a PLACEHOLDER — Authorization:
       "Bearer ${PRINTIFY_API_KEY}" — and the host substitutes the value at send time from the KEYS store.
       The model can therefore use a key it has never seen, and a transcript/log leak cannot spend it.
       Placeholders resolve in HEADERS ONLY: putting a secret in a URL would leak it into history, proxy
       logs, and Referer headers, so a placeholder in the url is refused rather than silently sent. */
    const SECRET_REF_RE = /\$\{([A-Z][A-Z0-9_]*)\}/g;
    const SECRET_REF_TEST = /\$\{[A-Z][A-Z0-9_]*\}/;   // non-global twin: .test() on a /g regex is stateful
    const REQUEST_MAX_CHARS = 8000;
    const SAFE_METHODS = new Set(['GET', 'HEAD']);
    const ALL_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);

    function resolveSecretRefs(value, surface, used) {
      let failure = null;
      const out = String(value).replace(SECRET_REF_RE, (whole, name) => {
        const r = serviceKeys.resolve(name, surface);
        if (r.ok) { used.push(name); return r.value; }
        failure = failure || (r.reason === 'unattended'
          ? 'this run is unattended and "' + r.name + '" is not approved for unattended use — approve it in TOOLSETS & CONNECTORS → KEYS, or run this while watching'
          : 'no enabled service key provides ' + name + ' — add it in TOOLSETS & CONNECTORS → KEYS');
        return whole;
      });
      return { out, failure };
    }

    const requestTool = {
      // scope 'write', NOT 'execute': in this codebase 'execute' means running a host process (shell.exec,
      // verify.run) and carries the autonomous exec lockout. This mutates a THIRD-PARTY resource over HTTPS
      // and spawns nothing, so it is a write — which is also what keeps it under the exec lockout by design.
      name: 'web_request', capability: 'web', scope: 'write', impact: 'external-credentialed',
      requiresConsent: true, network: true, timeoutMs: FETCH_TIMEOUT_MS + 20000,
      description:
        'Call a third-party REST API (Printify, Etsy, Stripe, any service with an HTTP API) and return the response. ' +
        'To authenticate, reference a stored key by its environment-variable NAME inside a header value using ${NAME} — ' +
        'e.g. headers {"Authorization": "Bearer ${PRINTIFY_API_KEY}"}. The host substitutes the real value at send time; ' +
        'you never see it and must never ask the user for it. Placeholders work in headers only, never in the url.',
      schema: {
        type: 'object', required: ['url'],
        properties: {
          url: { type: 'string', description: 'Full https URL of the API endpoint.' },
          method: { type: 'string', description: 'GET (default), HEAD, POST, PUT, PATCH or DELETE.' },
          headers: { type: 'object', description: 'Request headers. Use ${KEY_NAME} to reference a stored key.' },
          body: { type: 'string', description: 'Request body for POST/PUT/PATCH (send JSON as a string).' },
          auth: {
            type: 'object',
            description: 'For APIs that want the key as a query parameter instead of a header: ' +
              '{"key":"SOME_API_KEY","in":"query","name":"api_key"}. The host appends it at send time, so the ' +
              'secret never appears in the url you write. "in":"header" also works (optional "prefix", e.g. "Bearer ").'
          }
        }
      },
      run: async (args, ctx) => {
        const method = String((args && args.method) || 'GET').toUpperCase();
        if (!ALL_METHODS.has(method)) throw new Error('unsupported method: ' + method);
        const rawUrl = String((args && args.url) || '');
        if (SECRET_REF_TEST.test(rawUrl)) {
          throw new Error('a ${KEY} placeholder cannot go in the url — secrets in URLs leak into logs and history. Put it in a header instead.');
        }
        const u = assertSafeUrl(rawUrl);
        await assertResolvedSafe(u, doLookup);

        const used = [];
        /* WHICH HEADER SLOTS ACTUALLY CARRY A SECRET. The redirect guard below used to decide this by NAME
           (authorization|cookie|x-api-key) — but the model picks the slot, and half the real API world puts
           the key somewhere else (X-Shopify-Access-Token, Private-Token, apikey, X-Auth-Token), so an open
           redirect on a trusted host forwarded the Commander's key to the attacker verbatim. The host does
           not need to guess: the substitution happens right here, so record the exact keys it wrote into. */
        const secretHeaders = new Set();
        const headers = { 'User-Agent': UA, 'Accept': 'application/json, text/plain;q=0.9, */*;q=0.8' };
        const src = (args && args.headers && typeof args.headers === 'object') ? args.headers : {};
        for (const k of Object.keys(src)) {
          if (/[\r\n]/.test(k) || /[\r\n]/.test(String(src[k]))) throw new Error('header contains a newline: ' + k);
          const before = used.length;
          const r = resolveSecretRefs(src[k], surface, used);
          if (r.failure) throw new Error(r.failure);
          if (used.length > before) secretHeaders.add(k.toLowerCase());   // this slot now holds a real key
          headers[k] = r.out;
        }
        /* A ${KEY} placeholder in the BODY is silently NOT substituted (headers only, by design) — which
           shipped the literal text "${STRIPE_API_KEY}" to the third party and left the model debugging a
           confusing 401. Refuse it with the same clarity the url check already uses. */
        if (args && args.body != null && SECRET_REF_TEST.test(String(args.body))) {
          throw new Error('a ${KEY} placeholder cannot go in the body — the host substitutes stored keys into HEADERS only. Put it in a header (or use "auth").');
        }
        /* AUTH DESCRIPTOR — for APIs that take the key as a query parameter. The model NAMES the key and the
           slot; the HOST resolves and attaches it here, after the model has finished composing the request.
           That keeps the "a secret never appears in a url the model wrote" rule intact while still covering
           the (real, common) class of APIs that will not accept a header. The value is attached only to the
           FIRST hop: a redirect target comes from the server, so an open redirect cannot carry it onward. */
        const auth = (args && args.auth && typeof args.auth === 'object') ? args.auth : null;
        if (auth) {
          const where = String(auth.in || 'header').toLowerCase();
          const slot = String(auth.name || '').trim();
          const keyName = String(auth.key || '').trim();
          if (!slot) throw new Error('auth.name is required (the header or query-parameter name to put the key in)');
          if (!/^[A-Z][A-Z0-9_]*$/.test(keyName)) throw new Error('auth.key must be a stored key NAME like PRINTIFY_API_KEY, never a key value');
          if (where !== 'query' && where !== 'header') throw new Error('auth.in must be "query" or "header"');
          const r = serviceKeys.resolve(keyName, surface);
          if (!r.ok) {
            throw new Error(r.reason === 'unattended'
              ? 'this run is unattended and "' + r.name + '" is not approved for unattended use — approve it in TOOLSETS & CONNECTORS → KEYS, or run this while watching'
              : 'no enabled service key provides ' + keyName + ' — add it in TOOLSETS & CONNECTORS → KEYS');
          }
          used.push(keyName);
          if (where === 'query') u.searchParams.set(slot, r.value);
          else { headers[slot] = String(auth.prefix || '') + r.value; secretHeaders.add(slot.toLowerCase()); }
        }

        const hasBody = method !== 'GET' && method !== 'HEAD' && args && args.body != null;
        if (hasBody && !Object.keys(headers).some(k => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';

        /* Redirects are followed manually so every hop is re-validated against the SSRF guard. Credentials are
           dropped the moment the ORIGIN changes — an open redirect must never forward the user's key.
           TWO corrections to what "origin" and "credential" mean here:
             · origin, not host. hostOf() ignores scheme and port, so an https -> http redirect on the SAME
               hostname kept the Authorization header and put the key on the wire in CLEARTEXT.
             · the slots we PROVABLY filled with a secret (secretHeaders), not a three-name denylist — plus
               the denylist, which still covers a credential the caller supplied literally rather than via
               ${KEY} (a pasted cookie or bearer we never resolved and therefore never recorded). */
        const originOf = (x) => x.protocol + '//' + hostOf(x) + ':' + (x.port || (x.protocol === 'https:' ? '443' : '80'));
        const firstOrigin = originOf(u);
        const isCredential = (k) => secretHeaders.has(k.toLowerCase()) || /^(authorization|cookie|x-api-key)$/i.test(k);
        let target = u, res = null;
        for (let hop = 0; hop < 5; hop++) {
          const sendHeaders = hop === 0 || originOf(target) === firstOrigin
            ? headers
            : Object.keys(headers).reduce((o, k) => (isCredential(k) ? o : (o[k] = headers[k], o)), {});
          res = await withTimeout(signal => doFetch(target.href, {
            method, headers: sendHeaders, body: hasBody ? String(args.body) : undefined, redirect: 'manual', signal
          }).then(async r => ({ status: r.status, ct: r.headers.get('content-type') || '', loc: r.headers.get('location') || '', body: await readBodyBounded(r) })), FETCH_TIMEOUT_MS, ctx && ctx.signal);
          if (res.status >= 300 && res.status < 400 && res.loc) {
            const next = assertSafeUrl(new URL(res.loc, target.href).href);
            await assertResolvedSafe(next, doLookup);
            target = next; continue;
          }
          break;
        }

        // The response is UNTRUSTED third-party data — fenced like every other external content path so a
        // hostile API body cannot issue instructions. redact() strips any secret that echoed back.
        const scrub = typeof deps.redact === 'function' ? deps.redact : (s => s);
        const bodyText = clamp(scrub(String(res.body || '')), REQUEST_MAX_CHARS);
        const label = method + ' ' + u.origin + u.pathname + ' -> HTTP ' + res.status + (used.length ? ' (authenticated with ' + used.join(', ') + ')' : '');
        return {
          content: fenceExternal(bodyText || '(empty response body)', label),
          summary: method + ' ' + hostOf(u) + ' ' + res.status
        };
      }
    };

    return {
      searchTool, fetchTool, requestTool, webSearch, webFetch,
      // exported for unit tests
      _internals: { parseDDGHtml, parseDDGLite, parseMojeek, unwrapDDG, isDDGBlocked, htmlToText, assertSafeUrl, assertResolvedSafe, isPrivateV4, isPrivateV6, fenceExternal, withTimeout, politeness },
      register(reg) { reg.register(searchTool); reg.register(fetchTool); reg.register(requestTool); return reg; }
    };
  }

  return { makeWebTools, makePoliteScheduler };
});
