/* Bounded public-HTTPS fetcher for Skill Exchange. Every redirect is revalidated through the
   station's existing URL + DNS guards. Dependency-injected so security cases need no network. */
'use strict';

const MAX_REDIRECTS = 4;
const MAX_BYTES = 256000;

function makeSkillDocumentFetcher(deps) {
  deps = deps || {};
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const assertSafeUrl = deps.assertSafeUrl;
  const assertResolvedSafe = deps.assertResolvedSafe;
  const lookup = deps.lookup;
  const timeoutMs = deps.timeoutMs > 0 ? deps.timeoutMs : 12000;

  async function checked(raw) {
    let u = assertSafeUrl ? assertSafeUrl(raw) : new URL(raw);
    if (u.protocol !== 'https:') throw new Error('skill sources must use HTTPS');
    if (u.username || u.password) throw new Error('skill source URLs cannot contain credentials');
    if (assertResolvedSafe) await assertResolvedSafe(u, lookup);
    return u;
  }
  async function bodyBytes(response) {
    const declared = Number(response && response.headers && response.headers.get('content-length')) || 0;
    if (declared > MAX_BYTES) throw new Error('SKILL.md is larger than 256 KB');
    if (response.body && response.body[Symbol.asyncIterator]) {
      const chunks = []; let total = 0;
      for await (const chunk of response.body) {
        const buf = Buffer.from(chunk); total += buf.length;
        if (total > MAX_BYTES) throw new Error('SKILL.md is larger than 256 KB');
        chunks.push(buf);
      }
      return Buffer.concat(chunks);
    }
    const bytes = response.arrayBuffer ? Buffer.from(await response.arrayBuffer()) : Buffer.from(await response.text(), 'utf8');
    if (bytes.length > MAX_BYTES) throw new Error('skill package file is larger than 256 KB');
    return bytes;
  }
  async function fetchDocument(raw) {
    if (typeof fetchImpl !== 'function') throw new Error('network fetch is unavailable');
    let u = await checked(raw);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      let response;
      try {
        response = await fetchImpl(u.href, {
          method: 'GET', redirect: 'manual', signal: ctrl.signal,
          headers: { accept: 'text/markdown,text/plain;q=0.9,*/*;q=0.1', 'user-agent': 'StarNet-Skill-Exchange/1' }
        });
      } catch (e) {
        if (ctrl.signal.aborted) throw new Error('skill source timed out');
        throw e;
      } finally { clearTimeout(timer); }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers && response.headers.get('location');
        if (!location) throw new Error('skill source redirected without a location');
        if (hop === MAX_REDIRECTS) throw new Error('skill source redirected too many times');
        u = await checked(new URL(location, u.href).href);
        continue;
      }
      if (!response.ok) throw new Error('skill source returned HTTP ' + response.status);
      const bytes = await bodyBytes(response);
      return { url: u.href, bytes, text: bytes.toString('utf8') };
    }
    throw new Error('skill source redirected too many times');
  }
  return fetchDocument;
}

function referencedPaths(text) {
  const found = new Set();
  const re = /(?:^|[\s(`'"\[])((?:references|templates|scripts|assets)\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+)/g;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const p = m[1].replace(/[)\]}>.,;:'"]+$/, '');
    if (p && !p.split('/').includes('..')) found.add(p);
  }
  return Array.from(found);
}

function makeSkillPackageFetcher(deps) {
  deps = deps || {};
  const fetchDocument = deps.fetchDocument;
  if (typeof fetchDocument !== 'function') throw new Error('document fetcher required');

  async function generic(sourceUrl) {
    const main = await fetchDocument(sourceUrl);
    const files = [{ path: 'SKILL.md', bytes: main.bytes || Buffer.from(main.text || '', 'utf8') }];
    const base = new URL('.', main.url || sourceUrl);
    const queue = referencedPaths(main.text); const seen = new Set(queue);
    while (queue.length) {
      const rel = queue.shift();
      const got = await fetchDocument(new URL(rel, base).href);
      const bytes = got.bytes || Buffer.from(got.text || '', 'utf8');
      files.push({ path: rel, bytes });
      if (/\.(?:md|txt|json|ya?ml|js|mjs|cjs|ts|tsx|jsx|py|sh|ps1|html|css|xml|csv)$/i.test(rel)) {
        for (const child of referencedPaths(bytes.toString('utf8'))) if (!seen.has(child)) { seen.add(child); queue.push(child); }
      }
    }
    return { url: main.url || sourceUrl, files };
  }
  async function github(sourceUrl) {
    const u = new URL(sourceUrl);
    const bits = u.pathname.split('/').filter(Boolean);
    if (u.hostname !== 'raw.githubusercontent.com' || bits.length < 4) return generic(sourceUrl);
    const owner = bits[0], repo = bits[1], ref = bits[2];
    const skillPath = bits.slice(3).join('/');
    if (!/(?:^|\/)SKILL\.md$/i.test(skillPath)) return generic(sourceUrl);
    const rootPath = skillPath.replace(/\/?SKILL\.md$/i, '');
    const apiBase = 'https://api.github.com/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo) + '/contents/';
    const files = [];
    async function walk(relDir) {
      const apiPath = [rootPath, relDir].filter(Boolean).join('/');
      const response = await fetchDocument(apiBase + apiPath.split('/').map(encodeURIComponent).join('/') + '?ref=' + encodeURIComponent(ref));
      let rows;
      try { rows = JSON.parse(response.text); } catch (_) { throw new Error('GitHub returned an invalid skill directory listing'); }
      if (!Array.isArray(rows)) throw new Error('GitHub did not return a skill directory');
      for (const row of rows) {
        const relative = String(row && row.path || '').slice(rootPath ? rootPath.length + 1 : 0).replace(/\\/g, '/');
        if (row.type === 'dir') {
          if (['references', 'templates', 'scripts', 'assets'].includes(relative.split('/')[0])) await walk(relative);
        } else if (row.type === 'file' && (relative === 'SKILL.md' || ['references', 'templates', 'scripts', 'assets'].includes(relative.split('/')[0]))) {
          if (!row.download_url) throw new Error('GitHub package file has no immutable download URL: ' + relative);
          const got = await fetchDocument(row.download_url);
          files.push({ path: relative, bytes: got.bytes || Buffer.from(got.text || '', 'utf8') });
        }
      }
    }
    await walk('');
    return { url: sourceUrl, files };
  }
  return github;
}

module.exports = { makeSkillDocumentFetcher, makeSkillPackageFetcher, referencedPaths, MAX_REDIRECTS, MAX_BYTES };
