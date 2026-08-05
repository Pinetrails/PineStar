/* sidecar/skills/exchange.js - staged installation of open SKILL.md documents.

   External instructions are untrusted bytes. The exchange therefore has one narrow lifecycle:
     inspect URL -> freeze exact bytes in a bounded, expiring stage -> install/update those bytes.

   The install operation never fetches again, so the Commander approves the same document that is
   persisted. Provenance rides on the ordinary per-agent skill record; the existing guard/gate then
   decides whether the model may read it. Pure apart from injected fetch/store/clock/hash seams. */
'use strict';

const catalog = require('./catalog.js');

const MAX_DOCUMENT_BYTES = 256000;
const DEFAULT_STAGE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_STAGES = 40;

function str(v) { return v == null ? '' : String(v); }
function list(v) {
  if (Array.isArray(v)) return v.map(x => str(x).trim()).filter(Boolean);
  return v == null || v === '' ? [] : [str(v).trim()].filter(Boolean);
}

function normalizeSourceUrl(raw) {
  const input = str(raw).trim();
  if (!input || input.length > 2048) throw new Error('enter a public HTTPS URL to a SKILL.md file');
  let u;
  try { u = new URL(input); } catch (_) { throw new Error('that is not a valid URL'); }
  if (u.protocol !== 'https:') throw new Error('skill sources must use HTTPS');
  if (u.username || u.password) throw new Error('skill source URLs cannot contain credentials');
  u.hash = '';

  // GitHub's visible file page is what people naturally paste. Fetch the immutable document bytes,
  // not the surrounding HTML. Branch names containing slashes should be shared as raw URLs.
  if (u.hostname.toLowerCase() === 'github.com') {
    const bits = u.pathname.split('/').filter(Boolean);
    if (bits.length >= 5 && bits[2] === 'blob') {
      u = new URL('https://raw.githubusercontent.com/' + bits[0] + '/' + bits[1] + '/'
        + bits[3] + '/' + bits.slice(4).join('/'));
    }
  }
  return u.href;
}

function parseDocument(text, sourceUrl) {
  const raw = str(text).replace(/^\uFEFF/, '');
  if (!raw.trim()) throw new Error('the source returned an empty document');
  if (Buffer.byteLength(raw, 'utf8') > MAX_DOCUMENT_BYTES) throw new Error('SKILL.md is larger than 256 KB');
  const fm = catalog.parseFrontmatter(raw);
  const name = str(fm.meta.name).trim();
  const description = str(fm.meta.description).trim();
  const body = str(fm.body).trim();
  if (!name) throw new Error('SKILL.md frontmatter must include name');
  if (!description) throw new Error('SKILL.md frontmatter must include description');
  if (!body) throw new Error('SKILL.md needs instructions below its frontmatter');
  if (name.length > 80) throw new Error('skill name is longer than 80 characters');
  return {
    name,
    summary: description.slice(0, 280),
    description: description.slice(0, 280),
    body,
    category: str(fm.meta.category || 'Imported').trim().slice(0, 80) || 'Imported',
    requires: list(fm.meta.requires),
    platforms: list(fm.meta.platforms),
    sourceVersion: str(fm.meta.version).trim().slice(0, 80),
    sourceAuthor: str(fm.meta.author).trim().slice(0, 160),
    sourceLicense: str(fm.meta.license).trim().slice(0, 80),
    sourceUrl
  };
}

function cleanScan(scan) {
  scan = scan || {};
  return {
    verdict: str(scan.verdict || 'safe'),
    summary: str(scan.summary || 'safe'),
    findings: (Array.isArray(scan.findings) ? scan.findings : []).map(f => ({
      patternId: str(f && f.patternId), severity: str(f && f.severity), category: str(f && f.category),
      file: str(f && f.file), line: Number(f && f.line) || 0, description: str(f && f.description)
    }))
  };
}

function makeSkillExchange(deps) {
  deps = deps || {};
  const fetchDocument = deps.fetchDocument;
  const skillStore = deps.skillStore;
  const guard = deps.guard;
  const hash = deps.hash;
  const now = typeof deps.now === 'function' ? deps.now : () => 0;
  const makeId = typeof deps.makeId === 'function' ? deps.makeId : (() => { let n = 0; return () => 'stage-' + (++n); })();
  const ttlMs = deps.stageTtlMs > 0 ? deps.stageTtlMs : DEFAULT_STAGE_TTL_MS;
  const maxStages = deps.maxStages > 0 ? deps.maxStages : DEFAULT_MAX_STAGES;
  const stages = new Map();

  function sweep() {
    const t = now();
    for (const [id, stage] of stages) if (stage.expiresAt <= t) stages.delete(id);
    while (stages.size >= maxStages) stages.delete(stages.keys().next().value);
  }
  function digest(raw) {
    if (typeof hash !== 'function') throw new Error('skill exchange hash is unavailable');
    return str(hash(raw));
  }
  function previewOf(stage) {
    const d = stage.document;
    return {
      inspectionId: stage.id, expiresAt: stage.expiresAt, sourceUrl: d.sourceUrl,
      sourceDigest: stage.sourceDigest, name: d.name, summary: d.summary, category: d.category,
      requires: d.requires.slice(), platforms: d.platforms.slice(), version: d.sourceVersion,
      author: d.sourceAuthor, license: d.sourceLicense, body: d.body, scan: cleanScan(stage.scan),
      guardAction: stage.guardAction
    };
  }
  async function inspect(input) {
    if (typeof fetchDocument !== 'function') throw new Error('skill fetching is unavailable');
    const sourceUrl = normalizeSourceUrl(input && input.url);
    const fetched = await fetchDocument(sourceUrl);
    const finalUrl = normalizeSourceUrl((fetched && fetched.url) || sourceUrl);
    const raw = str(fetched && fetched.text);
    const document = parseDocument(raw, finalUrl);
    const projected = Object.assign({}, document, { setup: '', files: [], createdBy: 'community' });
    const scan = guard && typeof guard.scanSkillRecord === 'function'
      ? guard.scanSkillRecord(projected, { source: 'community' }) : { verdict: 'safe', findings: [], summary: 'safe' };
    const policy = guard && typeof guard.shouldAllow === 'function'
      ? guard.shouldAllow(scan, { allowAsk: true }) : { action: 'allow' };
    sweep();
    const id = str(makeId());
    const stage = { id, createdAt: now(), expiresAt: now() + ttlMs, sourceDigest: digest(raw), raw, document, scan, guardAction: str(policy.action || 'allow') };
    stages.set(id, stage);
    return previewOf(stage);
  }
  function getStage(id, expectedDigest) {
    sweep();
    const stage = stages.get(str(id));
    if (!stage) throw new Error('that inspection expired; inspect the source again');
    if (expectedDigest && str(expectedDigest) !== stage.sourceDigest) throw new Error('the inspected content digest does not match');
    return stage;
  }
  function findBySource(agentId, sourceUrl) {
    if (!skillStore || typeof skillStore.list !== 'function') return null;
    return skillStore.list(agentId, { includeArchived: true }).find(s => str(s.sourceUrl) === sourceUrl) || null;
  }
  function install(input) {
    if (!skillStore || typeof skillStore.manage !== 'function') throw new Error('skill storage is unavailable');
    const agentId = str(input && input.agentId) || 'agent';
    const stage = getStage(input && input.inspectionId, input && input.sourceDigest);
    if (stage.guardAction === 'block') throw new Error('the skill guard blocked this package; remove the dangerous instructions at the source and inspect it again');
    const d = stage.document;
    const bySource = findBySource(agentId, d.sourceUrl);
    const byName = skillStore.list(agentId, { includeArchived: true }).find(s => str(s.name).toLowerCase() === d.name.toLowerCase()) || null;
    if (byName && (!bySource || byName.id !== bySource.id)) throw new Error('a different skill named "' + d.name + '" already exists');
    const common = {
      agentId, name: d.name, summary: d.summary, description: d.description, body: d.body,
      category: d.category, requires: d.requires, platforms: d.platforms, createdBy: 'community',
      sourceUrl: d.sourceUrl, sourceDigest: stage.sourceDigest, sourceFetchedAt: now(),
      sourceVersion: d.sourceVersion, sourceAuthor: d.sourceAuthor, sourceLicense: d.sourceLicense
    };
    const result = bySource
      ? skillStore.manage(Object.assign({}, common, { action: 'edit', target: bySource.id }))
      : skillStore.manage(Object.assign({}, common, { action: 'create' }));
    if (!result || !result.ok) throw new Error((result && result.error) || 'could not install the skill');
    stages.delete(stage.id);
    return { ok: true, action: bySource ? 'update' : 'install', skill: result.skill, guardAction: result.skill.guardAction || stage.guardAction };
  }
  async function check(input) {
    const agentId = str(input && input.agentId) || 'agent';
    const id = str(input && input.id);
    const current = skillStore && skillStore.view(agentId, id, { includeArchived: true, bump: false });
    if (!current) throw new Error('no such installed skill');
    if (!current.sourceUrl) throw new Error('this skill was created locally and has no update source');
    const preview = await inspect({ url: current.sourceUrl });
    return Object.assign({}, preview, {
      installedId: current.id, installedDigest: current.sourceDigest || '',
      updateAvailable: preview.sourceDigest !== str(current.sourceDigest)
    });
  }

  return { inspect, install, check, normalizeSourceUrl, parseDocument, _stages: stages };
}

module.exports = { makeSkillExchange, normalizeSourceUrl, parseDocument, MAX_DOCUMENT_BYTES };
