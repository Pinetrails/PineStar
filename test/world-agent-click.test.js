/* node test/world-agent-click.test.js — every visible floor body opens its own AGENT DOSSIER.

   The regression had two coupled causes: world.js discarded every agentHit that was not the hero, and
   app.js hard-coded the surviving click to StationUI.openAgent(0). The canvas and app are browser IIFEs,
   so this test executes the id-to-roster-index resolver against a two-agent station and source-locks the
   mouse-up seam that supplies the clicked body's stable id. Live canvas proof remains part of verification. */
'use strict';
const fs = require('fs');
const path = require('path');
const A = require('./_assert.js');

const readApp = root => fs.readFileSync(path.join(__dirname, '..', root, 'app', 'app.js'), 'utf8');
const readWorld = root => fs.readFileSync(path.join(__dirname, '..', root, 'app', 'world.js'), 'utf8');
const appSrc = readApp('frontend');
const worldSrc = readWorld('frontend');

/* ---- 1. Execute the app-side resolver: stable id -> the matching dossier roster index. ---- */
const resolverMatch = appSrc.match(/function openWorldAgent\(agentId\) \{[\s\S]*?\n  \}/);
A.ok(resolverMatch, 'app.js defines the world-body -> dossier resolver');
if (!resolverMatch) A.report('world-agent-click.test');

const roster = [{ id: 'agent', name: 'NOVA' }, { id: 'strategist-1', name: 'STRATEGIST' }];
const opened = [];
// eslint-disable-next-line no-new-func
const openWorldAgent = new Function('liveAgents', 'StationUI', resolverMatch[0] + '; return openWorldAgent;')(
  () => roster.slice(),
  { openAgent: i => opened.push(i) }
);

A.eq(openWorldAgent('agent'), true, 'the Overseer body remains clickable');
A.eq(opened, [0], 'the Overseer opens roster index 0');
A.eq(openWorldAgent('strategist-1'), true, 'a specialist body is clickable too');
A.eq(opened, [0, 1], 'the specialist opens its own dossier index, not the Overseer');
A.eq(openWorldAgent('stale-agent'), false, 'a stale world body fails closed');
A.eq(opened, [0, 1], 'a stale body never opens the wrong dossier');

/* ---- 2. Lock the canvas seam: the shared agentHit result supplies its id for hero or crew. ---- */
const mouseup = worldSrc.slice(worldSrc.indexOf("cv.addEventListener('mouseup'"), worldSrc.indexOf("cv.addEventListener('mouseleave'"));
A.ok(mouseup.length > 0, 'world.js mouse-up handler is present');
A.ok(/const hit = agentHit\(wp\)/.test(mouseup), 'mouse-up captures the same body hit used by hover');
A.ok(/if \(hit\) \{[\s\S]*?onClick\(hit\.agentId \|\| hit\.id\)/.test(mouseup), 'every hit body sends its stable roster id through the click callback');
A.ok(!/agentHit\(wp\) === agent/.test(mouseup), 'the old hero-only click gate is gone');
A.ok(/if \(hit === agent && activity !== 'task'\)/.test(mouseup), 'the greeting animation remains hero-only');
A.ok(/World\.setOnClick\(openWorldAgent\)/.test(appSrc), 'the world click callback is wired to the id resolver');
A.ok(!/World\.setOnClick\([^\n]*openAgent\(0\)/.test(appSrc), 'the hard-coded Overseer dossier callback is gone');

/* ---- 3. The shipped website mirror carries the exact same behavior. ---- */
A.eq(readApp('website/app'), appSrc, 'website app.js mirrors the production frontend exactly');
A.eq(readWorld('website/app'), worldSrc, 'website world.js mirrors the production frontend exactly');

A.report('world-agent-click.test');
