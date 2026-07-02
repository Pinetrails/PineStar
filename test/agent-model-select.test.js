/* node test/agent-model-select.test.js — source-lock that per-agent MODEL SELECTION + RENAME are actually WIRED
   end to end (mirrors settings-p1-ui / autonomy-ui: these browser-flow modules aren't node-loadable, so we lock
   the wiring invariants against the source). Covers:
     · creation: the recruitment bay offers a model picker and threads it into summon (spec.modelPin)
     · summon: a summoned agent takes the chosen model AND its provider + effort (no more provider drift)
     · dossier: the CONFIG model card is a real picker + persists model/provider/effort; the name is renamable
     · plumbing: ModelDock exposes a pure catalog(); World.relabel follows a rename; the picker script loads */
'use strict';
const A = require('./_assert.js');
const fs = require('fs'); const path = require('path');
const app = (f) => fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', f), 'utf8');
const appjs = app('app.js'), ui = app('stationui.js'), mkt = app('marketplace.js'), dock = app('modeldock.js'), world = app('world.js');
const html = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'index.html'), 'utf8');

// ---- ModelDock: a PURE catalog + helper surface for other pickers (no Harness/DOM side effects) ----
A.ok(/catalog:\s*\(o\)\s*=>\s*computeCatalog/.test(dock), 'ModelDock exposes a pure catalog() accessor');
A.ok(/async function computeCatalog\(/.test(dock), 'computeCatalog fans out across providers without touching the dock');
A.ok(/labels:\s*\{/.test(dock) && /efforts:\s*\{/.test(dock), 'ModelDock exposes label + effort helpers for reuse');

// ---- the shared picker component loads before its consumers ----
A.ok(/app\/modelpicker\.js/.test(html), 'index.html loads the shared ModelPicker');
A.ok(html.indexOf('app/modeldock.js') < html.indexOf('app/modelpicker.js'), 'modelpicker loads AFTER modeldock (its data source)');
A.ok(html.indexOf('app/modelpicker.js') < html.indexOf('app/stationui.js'), 'modelpicker loads BEFORE the dossier that consumes it');

// ---- CREATION: the recruitment bay model picker → summon ----
A.ok(/function summonModelBarHTML\(/.test(mkt), 'the bay renders a SUMMON model bar');
A.ok(/ModelPicker\.shellHTML\(/.test(mkt), 'the bay model bar is built from the shared ModelPicker');
A.ok(/ModelPicker\.populate\(modelWrap/.test(mkt), 'the bay populates the catalog after mount');
A.ok(/modelPin:\s*pickedSummonModel/.test(mkt), 'the picked model is threaded into the onPick payload as modelPin');
A.ok(/html \+= summonModelBarHTML\(\)/.test(mkt), 'the model bar is actually inserted into the summon stage');

// ---- SUMMON: the new agent takes the chosen model AND its provider + effort ----
A.ok(/const pin = \(spec && spec\.modelPin\)/.test(appjs), 'summonAgent reads spec.modelPin');
A.ok(/model:\s*\(pin && pin\.model\)\s*\|\|\s*agent\.model/.test(appjs), 'summon uses the picked model, falling back to the hero');
A.ok(/provider:\s*\(pin && pin\.provider\)\s*\|\|\s*agent\.provider/.test(appjs), 'summon sets provider (fixes prior provider drift)');
A.ok(/reasoningEffort:\s*\(pin && pin\.effort\)/.test(appjs), 'summon sets reasoning effort');

// ---- DOSSIER model card: a real picker that persists model/provider/effort ----
A.ok(/function modelCard\(/.test(ui), 'the CONFIG model card still exists');
A.ok(/ModelPicker\.shellHTML\(/.test(ui), 'the model card is built from the shared ModelPicker');
A.ok(/ModelPicker\.populate\(pickWrap/.test(ui), 'the model card preselects + populates the picker from the agent pin');
A.ok(/access\.config\.setModel\(a && a\.id, model, provider, effort\)/.test(ui), 'the card persists model + provider + effort (4-arg setModel)');
A.ok(/id="ag-model-in"/.test(ui) && /id="ag-prov-in"/.test(ui), 'the advanced free-text escape hatch is preserved');

// ---- setAgentModelPin gains an OPTIONAL effort arg (additive, old callers untouched) ----
A.ok(/function setAgentModelPin\(agentId, model, provider, effort\)/.test(appjs), 'setAgentModelPin accepts an optional effort');
A.ok(/arguments\.length >= 4/.test(appjs), 'effort is only written when the 4th arg is passed (back-compatible)');

// ---- DOSSIER rename ----
A.ok(/data-goconfig="1"/.test(ui), 'the model tag is a one-click shortcut into CONFIG');
A.ok(/id="ag-rename-btn"/.test(ui) && /id="ag-rename-in"/.test(ui), 'the dossier header has a rename affordance + inline editor');
A.ok(/function wireHead\(/.test(ui) && /wireHead\(body\)/.test(ui), 'wireHead is defined and called for every tab');
A.ok(/access\.config\.setName/.test(ui), 'rename persists through config.setName');

// ---- setAgentName: display-only rename that keeps the prompt + floor honest, then persists ----
A.ok(/function setAgentName\(/.test(appjs), 'App implements setAgentName');
A.ok(/setName:\s*setAgentName/.test(appjs), 'setName is exposed on the config access surface');
A.ok(/function setAgentName[\s\S]{0,600}toUpperCase\(\)\.slice\(0, 18\)/.test(appjs), 'the name is normalized (UPPER, capped 18) like a summoned name');
A.ok(/function setAgentName[\s\S]{0,900}composeSystemPrompt\(a\)/.test(appjs), 'rename recomposes the system prompt (the default identity embeds the name)');
A.ok(/function setAgentName[\s\S]{0,1200}pushRoster\(\)[\s\S]{0,120}persist\(\)/.test(appjs), 'rename reaches the sidecar roster + persists');

// ---- World.relabel: the floor nameplate follows a rename ----
A.ok(/function relabel\(id, name\)/.test(world), 'World implements relabel');
A.ok(/spawnAgent, relabel,/.test(world), 'relabel is exported on the World public API');
A.ok(/World\.relabel/.test(appjs), 'setAgentName relabels the floor body');

A.report('agent-model-select.test');
