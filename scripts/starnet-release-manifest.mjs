#!/usr/bin/env node
/* Generate a Tauri updater latest.json manifest for StarNet desktop releases.
   Example:
   node scripts/starnet-release-manifest.mjs --version 0.2.0 \
     --url https://updates.starnet.app/desktop/StarNet_0.2.0_x64-setup.exe \
     --signature-file src-tauri/target/release/bundle/nsis/StarNet_0.2.0_x64-setup.exe.sig \
     --notes-file RELEASE_NOTES.md --out release/latest.json */
import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error('unexpected argument: ' + a);
    const key = a.slice(2);
    const val = argv[i + 1];
    if (!val || val.startsWith('--')) throw new Error('missing value for --' + key);
    out[key] = val;
    i++;
  }
  return out;
}

function need(args, key) {
  const v = args[key];
  if (!v) throw new Error('missing --' + key);
  return v;
}

function readText(file) {
  return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim();
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const version = need(args, 'version').replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error('--version must be SemVer, for example 0.2.0');
  }
  const url = need(args, 'url');
  if (!/^https:\/\//i.test(url)) throw new Error('--url must be https:// for production updater safety');
  const signature = readText(need(args, 'signature-file'));
  if (!signature) throw new Error('signature file is empty');
  const notes = args['notes-file'] ? readText(args['notes-file']) : (args.notes || '');
  const platform = args.platform || 'windows-x86_64';
  const outFile = args.out || 'release/latest.json';
  const pubDate = args['pub-date'] || new Date().toISOString();

  const manifest = {
    version,
    notes,
    pub_date: pubDate,
    platforms: {
      [platform]: { signature, url }
    }
  };

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(manifest, null, 2) + '\n');
  console.log('wrote ' + outFile + ' for ' + platform + ' v' + version);
}

try { main(); }
catch (e) { console.error('starnet-release-manifest: ' + e.message); process.exit(1); }
