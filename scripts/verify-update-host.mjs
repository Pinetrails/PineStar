#!/usr/bin/env node
/*
 * verify-update-host.mjs — prove the live desktop updater path end-to-end.
 *
 * Fetches the updater endpoint from src-tauri/tauri.conf.json (the GitHub Releases
 * latest.json), validates the manifest schema and signature fields, checks that the
 * manifest version is >= the shipped tauri version, and confirms the referenced
 * installer asset URL is actually reachable.
 *
 * Run this AFTER Andrew uploads a release — one command that turns "should work" into
 * "does work". Exit 0 = the updater path is live and coherent; non-zero = something a
 * user's app would choke on.
 *
 * USAGE:
 *   node scripts/verify-update-host.mjs [--endpoint URL] [--expect-version X.Y.Z]
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
function argVal(name, dflt) {
  const eq = args.find(a => a.startsWith(name + '='));
  if (eq) return eq.slice(name.length + 1);
  const idx = args.indexOf(name);
  if (idx >= 0 && args[idx + 1] && !args[idx + 1].startsWith('--')) return args[idx + 1];
  return dflt;
}
function readText(f) { return readFileSync(f, 'utf8').replace(/^﻿/, ''); }
function readJson(f) { return JSON.parse(readText(f)); }

const conf = readJson(join(ROOT, 'src-tauri', 'tauri.conf.json'));
const CONF_VERSION = conf.version;
const CONF_ENDPOINT = conf.plugins && conf.plugins.updater && conf.plugins.updater.endpoints
  && conf.plugins.updater.endpoints[0];
const ENDPOINT = argVal('--endpoint', CONF_ENDPOINT);
const EXPECT_VERSION = argVal('--expect-version', '');

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail: detail || '' });
  process.stdout.write((ok ? '  PASS ' : '  FAIL ') + name + (detail ? '  — ' + detail : '') + '\n');
}

function semverGte(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return true;
}

async function fetchWithTimeout(url, opts, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms || 20000);
  try { return await fetch(url, Object.assign({ signal: ctrl.signal, redirect: 'follow' }, opts || {})); }
  finally { clearTimeout(t); }
}

async function main() {
  process.stdout.write('== verify-update-host ==\n');
  process.stdout.write('  endpoint       : ' + ENDPOINT + '\n');
  process.stdout.write('  shipped version: ' + CONF_VERSION + '\n\n');

  if (!ENDPOINT) { check('updater endpoint configured', false, 'no endpoint in tauri.conf.json'); return finish(); }
  check('endpoint is https', /^https:\/\//i.test(ENDPOINT), ENDPOINT);
  check('endpoint is a GitHub Releases latest.json',
    /^https:\/\/github\.com\/.+\/releases\/latest\/download\/latest\.json$/.test(ENDPOINT), '');

  let manifest = null;
  try {
    const res = await fetchWithTimeout(ENDPOINT, { headers: { 'User-Agent': 'starnet-verify-update-host' } });
    check('latest.json is reachable (HTTP ' + res.status + ')', res.ok, res.ok ? '' : 'status ' + res.status);
    if (res.ok) {
      const text = await res.text();
      try { manifest = JSON.parse(text.replace(/^﻿/, '')); check('latest.json is valid JSON', true); }
      catch (e) { check('latest.json is valid JSON', false, e.message); }
    }
  } catch (e) {
    check('latest.json is reachable', false, e.name === 'AbortError' ? 'timeout' : e.message);
  }

  if (!manifest) return finish();

  // Tauri updater manifest schema.
  check('manifest.version present', typeof manifest.version === 'string' && manifest.version.length > 0, manifest.version);
  check('manifest.pub_date present', typeof manifest.pub_date === 'string' && !isNaN(Date.parse(manifest.pub_date)), manifest.pub_date);
  const plat = manifest.platforms && manifest.platforms['windows-x86_64'];
  check('manifest.platforms["windows-x86_64"] present', !!plat);
  if (plat) {
    check('platform.signature is a non-empty updater signature',
      typeof plat.signature === 'string' && plat.signature.trim().length > 40, '');
    check('platform.url is https', typeof plat.url === 'string' && /^https:\/\//i.test(plat.url), plat.url);
  }

  // Version coherence.
  if (EXPECT_VERSION) {
    check('manifest.version matches --expect-version', manifest.version === EXPECT_VERSION.replace(/^v/, ''),
      'got ' + manifest.version + ', expected ' + EXPECT_VERSION);
  }
  check('manifest.version >= shipped tauri version', semverGte(manifest.version, CONF_VERSION),
    'manifest ' + manifest.version + ' vs shipped ' + CONF_VERSION);

  // Installer asset reachability (HEAD, follow redirects to the CDN).
  if (plat && plat.url) {
    try {
      let res = await fetchWithTimeout(plat.url, { method: 'HEAD', headers: { 'User-Agent': 'starnet-verify-update-host' } });
      // Some CDNs reject HEAD; fall back to a ranged GET for 1 byte.
      if (!res.ok && (res.status === 403 || res.status === 405)) {
        res = await fetchWithTimeout(plat.url, { method: 'GET', headers: { 'User-Agent': 'starnet-verify-update-host', Range: 'bytes=0-0' } });
      }
      check('installer asset reachable (HTTP ' + res.status + ')', res.ok || res.status === 206,
        res.ok ? '' : 'status ' + res.status);
    } catch (e) {
      check('installer asset reachable', false, e.name === 'AbortError' ? 'timeout' : e.message);
    }
  }

  finish();
}

function finish() {
  const failed = checks.filter(c => !c.ok);
  process.stdout.write('\n== ' + (failed.length ? failed.length + ' CHECK(S) FAILED' : 'ALL CHECKS PASSED') + ' ==\n');
  if (failed.length) {
    process.stdout.write('The updater path is NOT yet live/coherent. Common causes:\n');
    process.stdout.write('  - release not published yet (draft releases do not resolve latest/download)\n');
    process.stdout.write('  - tag is not exactly v<version>, so the pinned installer URL 404s\n');
    process.stdout.write('  - latest.json / installer / .sig not all attached to the release\n');
    process.exit(1);
  }
  process.exit(0);
}

main().catch(e => { process.stderr.write('verify-update-host: ' + ((e && e.stack) || e) + '\n'); process.exit(1); });
