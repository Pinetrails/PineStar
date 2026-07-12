#!/usr/bin/env node
/* W1 gate — one installed first-user result plus installed transport truth.
 * The first-run runner cannot green W1 by itself: the disjoint link lane must provide a
 * candidate/artifact-bound receipt proving >40 seconds of healthy idle stays UP and an
 * actual connection loss transitions DOWN. */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateLinkReceipt } from '../../installed-first-run.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..', '..');
const QA_INSTALLED = path.join(ROOT, 'qa', 'installed');
const candidateCommit = String(process.env.STARNET_PRODUCT_PERFECT_CANDIDATE_SHA || '').trim().toLowerCase();
const artifactPath = String(process.env.STARNET_FIRST_RUN_ARTIFACT || process.env.STARNET_SMOKE_ARTIFACT || '').trim();

function runNode(label, args, timeoutMs) {
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT, env: process.env, encoding: 'utf8', windowsHide: true,
    timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) {
    console.error('[W1 BLOCKED] ' + label + ' — ' + result.error.message);
    return 2;
  }
  if (result.status !== 0) {
    const blocked = Number(result.status) === 2;
    console.error('[W1 ' + (blocked ? 'BLOCKED' : 'FAIL') + '] ' + label + ' — exit ' + result.status);
    return blocked ? 2 : 1;
  }
  console.log('[W1 PASS] ' + label);
  return 0;
}

function treeOf(commit) {
  if (!/^[0-9a-f]{40}$/.test(commit)) return '';
  const result = spawnSync('git', ['rev-parse', commit + '^{tree}'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  const value = String(result.stdout || '').trim().toLowerCase();
  return result.status === 0 && /^[0-9a-f]{40}$/.test(value) ? value : '';
}

function hashFile(file) {
  try {
    const resolved = path.resolve(file);
    const bytes = fs.readFileSync(resolved);
    const stat = fs.statSync(resolved);
    if (!stat.isFile() || bytes.length <= 0) return null;
    return { path: resolved, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
  } catch (_) { return null; }
}

function insideInstalled(file) {
  const relative = path.relative(QA_INSTALLED, path.resolve(file));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return false;
  const first = relative.split(/[\\/]/)[0];
  return /^smoke-/.test(first);   // the repo's existing ignored qa/installed runtime namespace
}

if (!/^[0-9a-f]{40}$/.test(candidateCommit)) {
  console.error('[W1 BLOCKED] controller did not provide an exact candidate SHA');
  process.exit(2);
}
const candidateTree = treeOf(candidateCommit);
if (!candidateTree) {
  console.error('[W1 BLOCKED] candidate source tree is unavailable');
  process.exit(2);
}
const artifact = hashFile(artifactPath);
if (!artifact) {
  console.error('[W1 BLOCKED] STARNET_FIRST_RUN_ARTIFACT must name the exact installed executable bytes');
  process.exit(2);
}

for (const [label, args] of [
  ['installed first-run authority tests', ['test/qa-installed-first-run.test.js']],
  ['Beginner title/recovery tests', ['test/qa-beginner.test.js']]
]) {
  const status = runNode(label, args, 120000);
  if (status) process.exit(status);
}

const linkReceiptInput = String(process.env.STARNET_W1_LINK_RECEIPT || '').trim();
const linkReceiptPath = linkReceiptInput ? path.resolve(ROOT, linkReceiptInput) : '';
if (!linkReceiptPath || !insideInstalled(linkReceiptPath)) {
  console.error('[W1 BLOCKED] STARNET_W1_LINK_RECEIPT must name a generated receipt beneath ignored qa/installed/smoke-*/');
  process.exit(2);
}
let linkReceipt = null;
try { linkReceipt = JSON.parse(fs.readFileSync(linkReceiptPath, 'utf8')); }
catch (_) {
  console.error('[W1 BLOCKED] installed link companion receipt is missing or unreadable');
  process.exit(2);
}
const linkVerdict = validateLinkReceipt(linkReceipt, { candidateCommit, candidateTree, artifact });
if (!linkVerdict.ok) {
  console.error('[W1 BLOCKED] installed link companion receipt failed: ' + linkVerdict.errors.join(', '));
  process.exit(2);
}
for (const evidence of linkVerdict.evidence) {
  const file = path.resolve(ROOT, evidence.path);
  if (!insideInstalled(file)) {
    console.error('[W1 BLOCKED] link evidence escaped qa/installed/: ' + evidence.path);
    process.exit(2);
  }
  const actual = hashFile(file);
  if (!actual || actual.sha256 !== evidence.sha256 || actual.size !== evidence.size) {
    console.error('[W1 BLOCKED] link evidence bytes do not match receipt: ' + evidence.path);
    process.exit(2);
  }
}
console.log('[W1 PASS] installed link truth (>40s quiet UP; actual loss DOWN)');

const journey = runNode('installed fresh-user first-value journey', ['scripts/qa/installed-first-run.mjs'], 700000);
if (journey) process.exit(journey);

console.log('[W1 PASS] exact installed candidate ' + candidateCommit + ' completed first value and transport truth');
process.exit(0);
