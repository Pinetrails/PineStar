#!/usr/bin/env node
// board.mjs — the coordination board DERIVED FROM GIT, not hand-maintained.
//
// WHY THIS EXISTS: SESSIONS.md is an UNTRACKED, hand-edited board. It drifts (the readiness
// memory literally calls it "STALE vs git"), has no history, and different sessions see
// different copies. The real ground truth — who is working where, what's unmerged, and which
// files are being edited RIGHT NOW — is all in git. This reads it and prints a board that
// cannot lie, plus the single most useful thing for parallel agents: the LIVE COLLISION
// SURFACE (every file with uncommitted edits, and which lane is touching it) so you can see an
// overlap BEFORE you cause it instead of after.
//
// Parsing uses `git status --porcelain -z` (NUL-delimited): no whole-output trim (which used to
// eat the first path's leading char and silently mis-key a real collision), no path quoting/octal
// escapes, and renames are handled (new+old are separate NUL fields). Untracked new files ARE
// included in the collision surface so two lanes adding the same new path is caught too.
//
// Zero deps. Usage:
//   node scripts/board.mjs            # print the board
//   node scripts/board.mjs --write    # also write scripts/STATUS.generated.md
//   node scripts/board.mjs --files X  # only show collision rows touching path-substring X

import { execSync, execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const TRUNK = process.env.STARNET_TRUNK || 'feat/harness-backend';
const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const FILES_FILTER = (() => {
  const i = args.indexOf('--files');
  if (i === -1) return null;
  const v = args[i + 1];
  if (!v || v.startsWith('--')) { console.error('[board] --files needs a path substring; showing all collisions instead.'); return null; }
  return v;
})();

const git = (cwd, cmd) => { try { return execSync('git ' + cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };

// NUL-safe porcelain: returns [{ xy, path, untracked }]. -z disables quoting/trim; rename/copy
// records carry the new path then the old path as two NUL fields — consume the old one.
function statusEntries(cwd) {
  let raw = '';
  try { raw = execFileSync('git', ['-C', cwd, 'status', '--porcelain', '-z', '--untracked-files=normal'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return []; }
  const parts = raw.split('\0');
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec) continue;
    const xy = rec.slice(0, 2);
    const path = rec.slice(3);
    if (xy[0] === 'R' || xy[0] === 'C' || xy[1] === 'R' || xy[1] === 'C') i++;   // skip the rename/copy source field
    out.push({ xy, path, untracked: xy === '??' });
  }
  return out;
}

function worktrees() {
  const out = git(ROOT, 'worktree list --porcelain');
  const wts = []; let cur = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) { cur = { path: line.slice(9).trim(), branch: '(detached)', head: '' }; wts.push(cur); }
    else if (line.startsWith('HEAD ') && cur) cur.head = line.slice(5, 12);
    else if (line.startsWith('branch ') && cur) cur.branch = line.slice(7).replace('refs/heads/', '');
  }
  return wts;
}

function laneInfo(wt) {
  const isTrunk = wt.branch === TRUNK;
  let ahead = 0, behind = 0;
  if (!isTrunk) { const lr = git(ROOT, `rev-list --left-right --count ${TRUNK}...${wt.branch}`).split(/\s+/); behind = +lr[0] || 0; ahead = +lr[1] || 0; }
  const lastLine = git(wt.path, 'log -1 --format=%cr%x09%s');   // %x09 = tab (no shell metachars, unlike | )
  const parts = lastLine.split('\t');
  const age = parts[0] || '?'; const subject = parts[1] || '';
  const entries = statusEntries(wt.path);
  const tracked = entries.filter((e) => !e.untracked).map((e) => e.path);
  const untrackedPaths = entries.filter((e) => e.untracked).map((e) => e.path);
  return { ...wt, isTrunk, ahead, behind, age, subject, tracked, untrackedPaths, untracked: untrackedPaths.length };
}

function classify(L) {
  if (L.isTrunk) return { tag: 'TRUNK', rank: 0 };
  if (L.tracked.length) return { tag: 'ACTIVE (uncommitted)', rank: 1 };
  if (L.ahead > 0) return { tag: 'UNMERGED (' + L.ahead + ' ahead)', rank: 2 };
  // git %cr emits "N weeks ago" for ~14-69 days — include weeks so that whole window is flagged
  if (/(week|month|year)s? ago/.test(L.age) || /([3-9]|\d\d) days? ago/.test(L.age)) return { tag: 'STALE', rank: 4 };
  return { tag: 'CLEAN/merged', rank: 3 };
}

const lanes = worktrees().map(laneInfo);
for (const L of lanes) L.cls = classify(L);
lanes.sort((a, b) => a.cls.rank - b.cls.rank || a.branch.localeCompare(b.branch));

// live collision surface: file -> { lanes[], tracked(=modified by someone), untracked(=newly added by someone) }
const fileMap = new Map();
function addFile(f, branch, untracked) {
  if (!fileMap.has(f)) fileMap.set(f, { lanes: [], tracked: false, untracked: false });
  const e = fileMap.get(f);
  if (e.lanes.indexOf(branch) < 0) e.lanes.push(branch);
  if (untracked) e.untracked = true; else e.tracked = true;
}
for (const L of lanes) { for (const f of L.tracked) addFile(f, L.branch, false); for (const f of L.untrackedPaths) addFile(f, L.branch, true); }
// show real edits (a tracked modification) + any contended path (incl. two lanes adding the same NEW file);
// hide a single lane's lone untracked scratch (e.g. .uishots/) so the signal stays high.
const collisions = [...fileMap.entries()]
  .filter(([, e]) => e.tracked || e.lanes.length >= 2)
  .sort((a, b) => b[1].lanes.length - a[1].lanes.length);

let md = '# StarNet board — derived from git (' + new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC)\n\n';
md += '> Generated by `scripts/board.mjs`. Source of truth = git, not a hand-edited file.\n\n';
md += '## Lanes\n\n| State | Branch | Ahead | Last activity | HEAD |\n|---|---|---|---|---|\n';
for (const L of lanes) md += `| ${L.cls.tag} | \`${L.branch}\` | ${L.ahead} | ${L.age} | ${(L.subject || '').slice(0, 46)} |\n`;

md += '\n## LIVE COLLISION SURFACE (files with uncommitted edits right now)\n\n';
md += 'Check this BEFORE you start editing — if your target file is here, coordinate first.\n\n';
const shown = FILES_FILTER ? collisions.filter(([f]) => f.includes(FILES_FILTER)) : collisions;
if (!shown.length) md += '_No uncommitted tracked edits in any worktree' + (FILES_FILTER ? ` matching "${FILES_FILTER}"` : '') + '._\n';
else {
  md += '| File | Lanes editing it | |\n|---|---|---|\n';
  for (const [f, e] of shown) {
    const kind = (e.untracked && !e.tracked) ? ' _(new file)_' : '';
    const warn = e.lanes.length > 1 ? '**CONTENDED**' : '';
    md += `| \`${f}\`${kind} | ${e.lanes.map((b) => '`' + b + '`').join(', ')} | ${warn} |\n`;
  }
}

const active = lanes.filter((L) => L.cls.rank === 1).map((L) => L.branch);
const unmerged = lanes.filter((L) => L.cls.rank === 2);
const contended = collisions.filter(([, e]) => e.lanes.length > 1);
md += '\n## Summary\n\n';
md += `- **Actively editing now:** ${active.length ? active.map((b) => '`' + b + '`').join(', ') : '_none_'}\n`;
md += `- **Unmerged (ahead of trunk):** ${unmerged.length ? unmerged.map((L) => '`' + L.branch + '`(' + L.ahead + ')').join(', ') : '_none_'}\n`;
md += `- **Contended files (2+ lanes):** ${contended.length}${contended.length ? ' — ' + contended.map(([f]) => '`' + f + '`').join(', ') : ''}\n`;

console.log(md);
if (WRITE) { const p = join(ROOT, 'scripts', 'STATUS.generated.md'); writeFileSync(p, md); console.log('(wrote ' + p + ')'); }
