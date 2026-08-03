#!/usr/bin/env node
/*
 * stage-website-deploy.mjs — build the exact directory that gets uploaded to starnetos.com
 *
 * WHY THIS EXISTS. starnetos.com is Cloudflare Pages by DIRECT UPLOAD: it has no git integration,
 * so merging a website lane to trunk publishes nothing and the live site only moves when someone
 * runs `wrangler pages deploy`. That command takes a DIRECTORY, and the obvious directory —
 * website/ — is not the thing we want published: pricing.html is written and reviewed but
 * deliberately held back (Andrew, 2026-08-02). Deploying website/ directly would publish it by
 * accident, and nobody would notice, because Cloudflare's catch-all answers 200 for every path.
 *
 * So the held-back set lives HERE, in code, instead of in whoever-remembers. Staging into a clean
 * directory also means a file deleted from website/ actually disappears from the upload rather
 * than lingering from a previous deploy.
 *
 * TO PUBLISH PRICING: delete it from HELD_BACK below, in the same commit that flips PRICING_LIVE
 * in website/site.js (that flag controls the links; this list controls the file). The two must
 * move together — a live page with hidden links, or visible links to an unpublished page, are
 * both worse than either state alone.
 *
 * Usage:
 *   node scripts/stage-website-deploy.mjs          # stage, then print the deploy command
 *   node scripts/stage-website-deploy.mjs --check  # list what would be held back; write nothing
 */
import { readdirSync, mkdirSync, copyFileSync, rmSync, statSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'website');
const OUT = join(ROOT, 'website-deploy');
const CHECK = process.argv.includes('--check');

// Paths (relative to website/, POSIX separators) that exist in the repo but must NOT be published.
const HELD_BACK = new Set([
  'pricing.html',
  // The no-credits legal variants below are sources for SUBSTITUTIONS, never pages of their own.
  'legal/_terms.nocredits.html',
  'legal/_privacy.nocredits.html'
]);

// Build-time sprite tooling is source, not a public web asset. Prefix rules cover future assembly helpers without
// requiring every new script to be added to this list, while HELD_BACK above remains strict for product pages.
const HELD_BACK_PREFIXES = ['app/assets/sprites/_assembly/'];

/* Holding pricing back is not only about the pricing page: terms.html clause 2 and privacy.html
   both describe the paid StarNet Credits program, and the terms cite the pricing page as forming
   part of them. Publishing that while the page itself is hidden would announce a paid tier nobody
   can read the price of, via a citation that resolves to the homepage.
   So the staged copies swap in variants carrying the wording ALREADY PUBLISHED on starnetos.com —
   no legal language invented for the hold. The repo keeps the full Credits versions, and the day
   pricing ships you delete these three entries and the real files publish untouched. */
const SUBSTITUTIONS = {
  'legal/terms.html': 'legal/_terms.nocredits.html',
  'legal/privacy.html': 'legal/_privacy.nocredits.html'
};

// Anything the staged legal pages must not contain while the paid tier is unannounced.
const CREDITS_WORDS = /credit|stripe|gateway|billing|subscription/i;

const PROJECT = 'starnet-site';

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else acc.push(relative(SRC, full).split(sep).join('/'));
  }
  return acc;
}

const all = walk(SRC);
const isHeldBack = f => HELD_BACK.has(f) || HELD_BACK_PREFIXES.some(prefix => f.startsWith(prefix));
const held = all.filter(isHeldBack);
const shipping = all.filter(f => !isHeldBack(f));

// A name in HELD_BACK that matches nothing is a silent no-op — the file was renamed or removed and
// the guard stopped guarding. Fail rather than deploy something the list believes it is blocking.
const missing = [...HELD_BACK].filter(f => !all.includes(f));
if (missing.length) {
  console.error('HELD_BACK names a file that no longer exists in website/: ' + missing.join(', '));
  console.error('Either restore it or drop it from the list — a stale guard is not a guard.');
  process.exit(1);
}

if (CHECK) {
  console.log('would publish ' + shipping.length + ' files; holding back ' + held.length + ':');
  for (const f of held) console.log('  - ' + f);
  process.exit(0);
}

// A substitution whose source vanished would silently publish the full-credits original.
for (const [target, source] of Object.entries(SUBSTITUTIONS)) {
  if (!all.includes(source)) {
    console.error('SUBSTITUTIONS points at a missing file: ' + source + ' (for ' + target + ')');
    process.exit(1);
  }
  if (!all.includes(target)) {
    console.error('SUBSTITUTIONS names a target that no longer exists: ' + target);
    process.exit(1);
  }
}

if (existsSync(OUT)) rmSync(OUT, { recursive: true });
for (const rel of shipping) {
  const dest = join(OUT, rel.split('/').join(sep));
  const from = SUBSTITUTIONS[rel] || rel;
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(join(SRC, from.split('/').join(sep)), dest);
  if (SUBSTITUTIONS[rel]) console.log('substituted: ' + rel + ' <- ' + from);
}

/* Prove the swap actually removed what it exists to remove, on the bytes that will be uploaded —
   not on the source we believed we copied. */
for (const rel of Object.keys(SUBSTITUTIONS)) {
  const staged = readFileSync(join(OUT, rel.split('/').join(sep)), 'utf8');
  const hit = staged.match(CREDITS_WORDS);
  if (hit) {
    console.error('staged ' + rel + ' still mentions "' + hit[0] + '" — refusing to deploy.');
    process.exit(1);
  }
}

/* The sitemap is the one file that can leak a held-back page even though the page itself never
   ships: Cloudflare's catch-all answers 200 for /pricing.html with the homepage body, so a
   crawler following the sitemap indexes a duplicate homepage under that URL instead of getting a
   404. Prune it from the staged copy rather than from the repo copy, so the entry is already in
   place the day pricing.html is allowed out. */
const sitemapPath = join(OUT, 'sitemap.xml');
if (existsSync(sitemapPath) && held.length) {
  const before = readFileSync(sitemapPath, 'utf8');
  const after = before
    .split(/\r?\n/)
    .filter(line => !held.some(f => line.includes('/' + f + '<')))
    .join('\n');
  const dropped = before.split(/\r?\n/).length - after.split(/\r?\n/).length;
  if (dropped) {
    writeFileSync(sitemapPath, after);
    console.log('pruned ' + dropped + ' held-back url(s) from the staged sitemap');
  }
}

console.log('staged ' + shipping.length + ' files -> website-deploy/');
for (const f of held) console.log('held back: ' + f);
console.log('\nnext:\n  npx wrangler pages deploy website-deploy --project-name ' + PROJECT);
