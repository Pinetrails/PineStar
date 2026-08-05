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
  async function bodyText(response) {
    const declared = Number(response && response.headers && response.headers.get('content-length')) || 0;
    if (declared > MAX_BYTES) throw new Error('SKILL.md is larger than 256 KB');
    if (response.body && response.body[Symbol.asyncIterator]) {
      const chunks = []; let total = 0;
      for await (const chunk of response.body) {
        const buf = Buffer.from(chunk); total += buf.length;
        if (total > MAX_BYTES) throw new Error('SKILL.md is larger than 256 KB');
        chunks.push(buf);
      }
      return Buffer.concat(chunks).toString('utf8');
    }
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw new Error('SKILL.md is larger than 256 KB');
    return text;
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
      return { url: u.href, text: await bodyText(response) };
    }
    throw new Error('skill source redirected too many times');
  }
  return fetchDocument;
}

module.exports = { makeSkillDocumentFetcher, MAX_REDIRECTS, MAX_BYTES };
