#!/usr/bin/env node
/* PS-2026-003: read-only release guard for private/reference art.
 * Compatibility-era StarNet assets are inventoried separately; this gate specifically prevents
 * newly introduced reference/placeholder material from silently entering distributable roots.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLACEHOLDER_MARKER = 'REFERENCE / PLACEHOLDER — DO NOT DISTRIBUTE';
export const PLACEHOLDER_NAME_RE = /(?:reference|placeholder).*(?:do[-_ ]?not[-_ ]?distribute)|do[-_ ]?not[-_ ]?distribute/i;
export const TEXT_EXTENSIONS = new Set([
  '.css', '.csv', '.html', '.js', '.json', '.md', '.mjs', '.svg', '.toml', '.ts', '.txt', '.xml', '.yaml', '.yml'
]);

export function scanDistributableRoots(root, roots) {
  const findings = [];
  const visit = (absolute, label) => {
    let entries = [];
    try { entries = readdirSync(absolute, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const file = resolve(absolute, entry.name);
      const rel = relative(root, file).split(sep).join('/');
      if (entry.isDirectory()) { visit(file, label); continue; }
      if (!entry.isFile()) continue;
      if (PLACEHOLDER_NAME_RE.test(entry.name)) findings.push({ path: rel, reason: 'placeholder filename' });
      if (!TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
      let size = 0;
      try { size = statSync(file).size; } catch { continue; }
      if (size > 2 * 1024 * 1024) continue;
      let text = '';
      try { text = readFileSync(file, 'utf8'); } catch { continue; }
      if (text.includes(PLACEHOLDER_MARKER)) findings.push({ path: rel, reason: 'distribution-blocking marker' });
    }
  };
  for (const item of roots) visit(resolve(root, item), item);
  return findings.sort((a, b) => a.path.localeCompare(b.path) || a.reason.localeCompare(b.reason));
}

function runCli() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const roots = ['frontend/assets', 'website/assets', 'website/app/assets', 'src-tauri/icons', 'src-tauri/installer'];
  const findings = scanDistributableRoots(root, roots);
  if (findings.length) {
    console.error('pine-star-asset-safety: BLOCKED — reference/placeholder material is in a distributable root');
    for (const item of findings) console.error('  - ' + item.path + ' (' + item.reason + ')');
    process.exitCode = 1;
    return;
  }
  console.log('pine-star-asset-safety: OK — no reference/placeholder markers in distributable roots');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runCli();
