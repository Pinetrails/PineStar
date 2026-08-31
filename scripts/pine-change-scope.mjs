#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const STOP = new Set(['add', 'and', 'change', 'complete', 'foundation', 'from', 'into', 'pine', 'star', 'that', 'the', 'this', 'with']);
function tokens(value) { return [...new Set(String(value || '').toLowerCase().match(/[a-z0-9]+/g) || [])].filter(x => x.length >= 4 && !STOP.has(x)); }
function subsystem(file) { const parts = String(file || '').replace(/\\/g, '/').split('/'); return parts.length > 1 ? parts[0] : '(root)'; }
function pathTokens(file) { return tokens(String(file || '').replace(/\.[^.]+$/, '').replace(/[\\/_-]+/g, ' ')); }
function expectedSupport(file) { return /^(test\/|docs\/change-records\/|CHANGELOG\.md$|PINE_STAR_CONTROL\.md$|docs\/(CURRENT_STATUS|ROADMAP)\.md$)/i.test(file); }

export function analyzeScope({ changeId = '', intent = '', files = [] } = {}) {
  const intentTokens = tokens(intent + ' ' + changeId), normalized = files.filter(x => x && x.path).map(x => ({ path: String(x.path).replace(/\\/g, '/'), additions: Number(x.additions) || 0, deletions: Number(x.deletions) || 0 }));
  const likelyCreep = [], inScope = [];
  for (const file of normalized) {
    const overlap = pathTokens(file.path).filter(x => intentTokens.includes(x));
    const row = { ...file, overlap };
    if (overlap.length || expectedSupport(file.path)) inScope.push(row);
    else likelyCreep.push({ ...row, reason: 'no path/intent keyword overlap; review rather than assuming it is unrelated' });
  }
  const dependencyFiles = normalized.filter(x => /(^|\/)(package(-lock)?\.json|requirements[^/]*\.txt|pyproject\.toml|Cargo\.toml)$/i.test(x.path)).map(x => x.path);
  const totals = normalized.reduce((a, x) => ({ additions: a.additions + x.additions, deletions: a.deletions + x.deletions }), { additions: 0, deletions: 0 });
  const subsystems = [...new Set(normalized.map(x => subsystem(x.path)))];
  return { schema: 'pine-star.change-scope.v1', changeId: String(changeId), intent: String(intent).trim(), files: normalized.length, totals, subsystems,
    signals: { likelyCreep, dependencyFiles, broadSubsystemChange: subsystems.length > 4, highChurn: totals.additions + totals.deletions > 800 }, inScope,
    disposition: likelyCreep.length || dependencyFiles.length || subsystems.length > 4 || totals.additions + totals.deletions > 800 ? 'REVIEW' : 'CLEAR',
    caveat: 'Deterministic triage only. Keyword overlap cannot prove scope or correctness.' };
}

function arg(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : ''; }
function git(args) { const out = spawnSync('git', args, { cwd: process.cwd(), encoding: 'utf8' }); if (out.status !== 0) throw new Error((out.stderr || out.stdout || 'git failed').trim()); return out.stdout; }
function changeIntent(changeId) {
  const file = path.join(process.cwd(), 'docs', 'change-records', changeId + '.md');
  if (!fs.existsSync(file)) return '';
  const body = fs.readFileSync(file, 'utf8'), section = body.match(/## Intent\s+([\s\S]*?)(?=\n## |$)/i);
  return ((body.match(/^#\s+(.+)$/m) || [])[1] || '') + ' ' + (section ? section[1] : '');
}
function parseNumstat(raw) { return raw.split(/\r?\n/).filter(Boolean).map(line => { const [a, d, ...p] = line.split('\t'); return { additions: a === '-' ? 0 : Number(a), deletions: d === '-' ? 0 : Number(d), path: p.join('\t') }; }); }

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/(.:)/, '$1'))) {
  try {
    const changeId = arg('--change-id'), explicit = arg('--intent'), staged = process.argv.includes('--staged');
    const diffArgs = ['diff']; if (staged) diffArgs.push('--cached'); diffArgs.push('--numstat');
    const report = analyzeScope({ changeId, intent: explicit || changeIntent(changeId), files: parseNumstat(git(diffArgs)) });
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } catch (error) { process.stderr.write('pine-change-scope: ' + error.message + '\n'); process.exitCode = 1; }
}
