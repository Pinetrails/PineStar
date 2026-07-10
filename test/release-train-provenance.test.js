/* node test/release-train-provenance.test.js — P1.5 release-train provenance gate invariants.

   The release train (.github/workflows/release-train.yml, `build` job) refuses to ship a binary unless
   `git describe --tags` resolves to the tag being built AND the built exe byte-contains the build.rs commit
   stamp. That gate is CORRECT, but it only works if the CI checkout actually has the tag + history available:
   with the default shallow `actions/checkout@v4` (fetch-depth 1, no tags) `git describe --tags` falls back to
   the bare short SHA, so `describe != tag` and the gate fails producing ZERO artifacts — exactly what stalled
   the v0.4.0 train (0 artifacts, 2026-07-08). The fix is `fetch-depth: 0` on the build-job checkout so the
   environment can compute a truthful describe (this does NOT loosen the gate — it feeds it real git data).

   This locks, without running CI:
     · the build job's checkout fetches full history+tags (fetch-depth: 0) so describe/build.rs see the tag.
     · the provenance gate itself is still present (describe==tag check + binary byte-scan) — a future edit that
       silently drops the gate is caught here.
     · build.rs and the yml compute `git describe` with the SAME flag set, so their describe output is identical
       (a drift between them would make the gate compare mismatched strings).
   Pure text/structural check — no node_modules, no YAML parser (js-yaml isn't a dep). */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const yml = fs.readFileSync(path.join(root, '.github', 'workflows', 'release-train.yml'), 'utf8');
const buildRs = fs.readFileSync(path.join(root, 'src-tauri', 'build.rs'), 'utf8');
const mainRs = fs.readFileSync(path.join(root, 'src-tauri', 'src', 'main.rs'), 'utf8');

// --- isolate the `build` job block (from its header to the next top-level job header) ---
const hdr = yml.match(/^  build:$/m);
A.ok(hdr, 'release-train.yml has a `build` job');
const bodyStart = hdr.index + hdr[0].length;
const afterBuild = yml.slice(bodyStart);
const nextJobRel = afterBuild.search(/^  [a-z0-9_-]+:$/m); // first sibling job header after `build:`
const buildJob = nextJobRel === -1 ? afterBuild : afterBuild.slice(0, nextJobRel);

// --- the build-job checkout must fetch full history + tags so `git describe --tags` resolves the tag ---
const coIdx = buildJob.indexOf('uses: actions/checkout@v4');
A.ok(coIdx !== -1, 'build job has an actions/checkout step');
// the checkout step spans until the next `- ` step marker at 6-space indent.
const fromCheckout = buildJob.slice(coIdx);
const nextStepRel = fromCheckout.slice(1).search(/\n      - /);
const checkoutStep = nextStepRel === -1 ? fromCheckout : fromCheckout.slice(0, nextStepRel + 1);
A.ok(/fetch-depth:\s*0\b/.test(checkoutStep),
  'build-job checkout uses fetch-depth: 0 (full history+tags — else `git describe --tags` returns the bare SHA and the provenance gate fails describe!=tag, shipping 0 artifacts)');

// --- the provenance gate must still exist (guard against a future edit quietly removing it) ---
A.ok(/git describe --tags --always --dirty/.test(buildJob),
  'provenance gate still computes `git describe --tags --always --dirty`');
A.ok(/grep -aq -- "\$COMMIT"/.test(buildJob),
  'provenance gate still byte-scans the built binary for the build.rs commit stamp');

// --- build.rs and the yml must describe with the SAME flags so their output is byte-identical ---
const rsDescribe = buildRs.match(/"describe"[^\)\]]*\]/);
A.ok(rsDescribe, 'build.rs invokes git describe');
const rsFlags = (rsDescribe[0].match(/--[a-z]+/g) || []).sort();
const ymlDescribe = buildJob.match(/\$\(git describe ([^)\n]*)\)/); // the real command, not the prose comments
A.ok(ymlDescribe, 'build job invokes `$(git describe …)`');
const ymlFlags = (ymlDescribe[1].match(/--[a-z]+/g) || []).sort();
A.eq(ymlFlags, rsFlags,
  'yml and build.rs `git describe` use the same flag set (identical describe output feeds the gate)');

// Installed proof needs the full immutable candidate SHA, not only the human-facing short commit.
A.ok(/rev-parse",\s*"HEAD/.test(buildRs) && /STARNET_BUILD_SHA/.test(buildRs),
  'build.rs embeds a full candidate SHA for installed-artifact proof');
A.ok(/\.env\("STARNET_BUILD_SHA",\s*env!\("STARNET_BUILD_SHA"\)\)/.test(mainRs),
  'desktop shell passes the full build SHA to the packaged sidecar');
A.ok(/sha:\s*env!\("STARNET_BUILD_SHA"\)/.test(mainRs),
  'starnet_build_info exposes the same full build SHA to the installed page');

A.report('release-train-provenance.test');
