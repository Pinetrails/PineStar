'use strict';
// genesis-starnet-link.test.js — source guard for the STARNET MANAGED path on the first-run connect screen.
// The subscription flow must be reachable at genesis (buy on the site → link in one confirmed code — no API
// key anywhere), and it must stay HONEST: the chip is hidden until the sidecar reports a real cloud seam,
// and WAKE refuses an unlinked pick instead of admitting a run the credits gate would bounce.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const index = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'app.js'), 'utf8');

let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n++; };

// STARNET is THE HERO (the promoted easiest start) and ships HIDDEN — only the live probe reveals it.
ok(/class="prov prov-hero hidden" data-prov="starnet"/.test(index), 'the STARNET hero ships hidden (honesty: no cloud, no offer)');
ok(/data-prov="starnet"[\s\S]{0,200}EASIEST START/.test(index), 'the STARNET hero wears the promoted-start badge');
// ChatGPT/Codex has no chip of its own anymore — its sign-in lives inside the OPENAI card.
ok(!/data-prov="codex"/.test(index), 'no standalone codex chip — ChatGPT sign-in lives inside the OPENAI selection');
ok(/pickedProvider === 'codex'\) pickedProvider = 'openai'/.test(app), 'a returning codex agent lands on the OPENAI card');
ok(/codexConnected\) \{[\s\S]{0,400}setProv\('codex'\)/.test(app) || /codexConnected[\s\S]{0,300}setProv\('codex'\)/.test(app),
  'WAKE on the OPENAI card rides the codex path when the ChatGPT sign-in is live and no key was typed');
// The revealed hero becomes the default pick on a fresh create — never over a real user click.
ok(/autoPick && \(linked \|\| linkable\) && !userPickedProvider/.test(app), 'the hero auto-pick yields to any real user pick');
ok(/id="starnet-block"/.test(index), 'the genesis link block exists');
ok(/id="btn-starnet-link"/.test(index) && /id="starnet-code"/.test(index) && /id="btn-starnet-open"/.test(index),
  'the link block carries its button, code display, and open-page control');

// The reveal is keyed on the sidecar seam, not hardcoded on.
ok(/async function revealStarnetGenesis\(/.test(app), 'genesis probes the cloud seam before offering the chip');
ok(/\/api\/credits\/linkable/.test(app), 'the reveal asks /api/credits/linkable (the STORE reads the same pair)');
ok(/revealStarnetGenesis\(!recovery\)/.test(app), 'the connect screen actually runs the reveal (auto-pick only on a fresh create)');

// The pairing flow rides the SAME sidecar engine as the STORE — one implementation.
ok(/\/api\/credits\/link\/start/.test(app) && /\/api\/credits\/link\/poll/.test(app),
  'genesis linking uses the sidecar pairing routes (the STORE engine, not a second copy)');
ok(/harness_adopt_credits_token/.test(app), 'a fresh link hands the token to the OS keychain immediately');
ok(/refreshCreditsConfigured/.test(app), "a fresh link teaches Harness so configured('starnet') answers without a restart");

// WAKE is gated: an unlinked STARNET pick is refused with the remedy named, before any agent exists.
ok(/pickedProvider === 'starnet'[\s\S]{0,240}starnetLinked[\s\S]{0,240}link your StarNet account first/i.test(app),
  'WAKE refuses an unlinked STARNET pick and names the one-button remedy');

// Leaving the screen (or switching provider) drops the in-flight pairing poll — no orphan pollers.
ok(/stopStarnetLinkPoll\(\)/.test(app), 'the pairing poll has a stop, wired on screen exit and provider switch');

console.log('genesis-starnet-link.test.js OK -', n, 'assertions');
