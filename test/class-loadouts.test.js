/* node test/class-loadouts.test.js — Class Loadouts S1 (the spine).

   A class = model tier + reasoning effort + skill package + standard-issue KIT, applied at summon and honored
   backend-side. Two halves, matching kitout.test.js's discipline:
     1. GROUNDED-CATALOG unit tests (real assertions on pure modules): the shared catalog is well-formed and
        HONEST — every kit objectType is a real CAP_REGISTRY key, every skill slug is a real bundled recipe, and
        every skill's `requires` is satisfied by its class's kit (Law 4: grounded classes only).
     2. UNIT tests for the wiring the backend depends on: catalog.compose(agentSkills) is an ADD-only union that
        respects the budget with the package first; the sidecar roster passes skills/effort through.
     3. SOURCE-LEVEL invariants for the browser-only summon path (app.js / build.js are IIFEs over live DOM, so —
        like kitout.test.js — we lock the honesty-critical wiring by reading the source). */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const shared = require('../shared/specialties.js');
const S = require('../frontend/app/specialties.js');
const catalog = require('../sidecar/skills/catalog.js');
const { CAP_REGISTRY } = require('../sidecar/capability/registry.js');

/* ---------- 1. GROUNDED CATALOG: kit + skills are REAL and honestly backed ---------- */
const CAP_TYPES = new Set(Object.keys(CAP_REGISTRY));
// the real bundled skill library (same loader the sidecar uses)
const LIB = catalog.loadDir(path.join(__dirname, '../sidecar/skills/library'), fs, path);
const SLUGS = new Map(LIB.map(s => [s.slug, s]));
A.ok(LIB.length >= 5, 'the bundled skill library loaded (' + LIB.length + ' recipes)');

const builtins = S.builtins();
A.ok(builtins.length >= 11, 'the class catalog ships every class (>= 11), got ' + builtins.length);

for (const b of builtins) {
  // every class has a loadout, and the loadout fields have the right shapes
  A.ok(Array.isArray(b.kit), b.id + ' has a kit array');
  A.ok(Array.isArray(b.skills), b.id + ' has a skills array');
  A.ok(b.reasoningEffort === null || ['high', 'medium', 'low'].indexOf(b.reasoningEffort) >= 0, b.id + ' effort is a known level or null: ' + b.reasoningEffort);
  A.throws(() => { b.kit.push('x'); }, b.id + ' kit is frozen (catalog immutable)');

  // Law 1/4: every kit objectType is a REAL CAP_REGISTRY key (never an invented prop)
  for (const t of b.kit) A.ok(CAP_TYPES.has(t), b.id + ' kit objectType is a real CAP_REGISTRY type: ' + t);

  // every skill slug is a REAL bundled recipe, and its requires ⊆ this class's kit (grounded — a class can
  // actually run the skill it ships). computer/connector are compute/dynamic, not skill requirements, so a
  // skill never requires them; every requires entry must be present in the kit.
  const kitSet = new Set(b.kit);
  for (const slug of b.skills) {
    const skill = SLUGS.get(slug);
    A.ok(!!skill, b.id + ' skill slug is a real library recipe: ' + slug);
    if (skill) for (const req of (skill.requires || [])) {
      A.ok(kitSet.has(req), b.id + ' skill "' + slug + '" requires "' + req + '" which its kit provides');
    }
  }
}

/* ---------- 1b. S2 CONTENT: the full 18-class roster, seals/codes, prompt-size sanity ---------- */
const classicons = require('../frontend/app/classicons.js');
// the roster grew from 11 to 18 in S2 (7 new: broker/publicist/tutor/auditor/bookkeeper/translator/herald)
A.eq(builtins.length, 18, 'the S2 catalog ships all 18 classes');
const NEW_CLASSES = ['broker', 'publicist', 'tutor', 'auditor', 'bookkeeper', 'translator', 'herald'];
const byId = new Map(builtins.map(b => [b.id, b]));
for (const id of NEW_CLASSES) {
  const b = byId.get(id);
  A.ok(!!b, 'new class present in catalog: ' + id);
  if (!b) continue;
  // every new class carries the full loadout + presentation fields (nothing half-authored)
  for (const f of ['name', 'emoji', 'tagline', 'blurb', 'purpose', 'manual', 'persona', 'model', 'accent']) {
    A.ok(b[f] && String(b[f]).length > 0, id + ' has a non-empty ' + f);
  }
  A.ok(['reasoning', 'balanced', 'fast'].indexOf(b.model) >= 0, id + ' has a real model tier: ' + b.model);
  A.ok(Array.isArray(b.starters) && b.starters.length === 3, id + ' ships exactly 3 starters');
  A.ok(Array.isArray(b.kit) && b.kit.length > 0, id + ' has a non-empty kit (grounded class)');
  A.ok(Array.isArray(b.skills) && b.skills.length > 0, id + ' ships at least one skill');
}
// unique ids + unique 3-letter class codes (a code collision would mis-stamp a coin)
const ids = builtins.map(b => b.id);
A.eq(new Set(ids).size, ids.length, 'every class id is unique');
const codes = builtins.map(b => classicons.code(b.id));
for (const c of codes) A.ok(/^[A-Z0-9]{3}$/.test(c), 'class code is a real 3-letter stamp: ' + c);
A.eq(new Set(codes).size, codes.length, 'every class code is unique (no coin collision): ' + codes.join(','));
// EVERY catalog id has a bespoke seal, and EVERY seal maps to a catalog id (no orphans either way)
for (const b of builtins) A.ok(!!classicons.svg(b.id), 'class has a bespoke seal icon: ' + b.id);
const iconIds = Object.keys(classicons.ICONS);
const catIds = new Set(ids);
for (const iid of iconIds) A.ok(catIds.has(iid), 'seal icon maps to a real catalog class (no orphan seal): ' + iid);
A.eq(iconIds.length, builtins.length, 'exactly one seal per class (' + iconIds.length + ' seals, ' + builtins.length + ' classes)');
// every seal is currentColor-themed SVG (rides the class accent, matches the engraved-coin style) — and no
// seal hardcodes a themed colour (only currentColor / none / the deboss floor #0c0704), so it themes to the accent.
for (const iid of iconIds) {
  const svg = classicons.ICONS[iid];
  A.ok(/^<svg/.test(svg) && /currentColor/.test(svg), 'seal ' + iid + ' is a currentColor SVG');
  // crude well-formedness: every opened element is closed (paired close OR self-close). Guards a truncated seal.
  const opens = (svg.match(/<[a-zA-Z]/g) || []).length;
  const closes = (svg.match(/<\/[a-zA-Z]/g) || []).length + (svg.match(/\/>/g) || []).length;
  A.eq(opens, closes, 'seal ' + iid + ' is well-formed (every element closed)');
  const colours = [...svg.matchAll(/(?:fill|stroke)="([^"]+)"/g)].map(m => m[1]);
  for (const c of colours) A.ok(c === 'currentColor' || c === 'none' || c === '#0c0704',
    'seal ' + iid + ' uses only currentColor/none/deboss (no theme-breaking hardcoded colour): ' + c);
}

/* ---------- 1b'. DISTINCTNESS: a beginner must be able to tell the classes apart at pick-time ---------- */
// taglines + blurbs are unique (no two classes present as the same thing in the bay).
const taglines = builtins.map(b => b.tagline.trim().toLowerCase());
A.eq(new Set(taglines).size, taglines.length, 'every class tagline is unique');
const blurbs = builtins.map(b => b.blurb.trim().toLowerCase());
A.eq(new Set(blurbs).size, blurbs.length, 'every class blurb is unique');
// the confusable pair broker/scout both touch prices — the broker blurb must DRAW the boundary (decide vs watch)
// so a beginner can predict which to pick. (Adversarial-review fix: broker retuned off the word "scout".)
const brokerBlurb = byId.get('broker').blurb.toLowerCase();
A.ok(/scout/.test(brokerBlurb) && /(decide|call|buy|which)/.test(brokerBlurb),
  'the broker blurb explicitly contrasts itself with the scout (decide-now vs watch-and-alert)');
A.ok(!/scout/.test(byId.get('broker').tagline.toLowerCase()),
  'the broker tagline no longer overloads the word "scout" (collided with the scout class)');

/* ---------- 1c. PROMPT-SIZE SANITY: manuals/purposes are injected every run — keep them tight ---------- */
for (const b of builtins) {
  A.ok(b.manual.length <= 1000, b.id + ' manual is prompt-tight (<=1000 chars): ' + b.manual.length);
  A.ok(b.purpose.length <= 450, b.id + ' purpose is prompt-tight (<=450 chars): ' + b.purpose.length);
  A.ok(b.manual.length > 200, b.id + ' manual is a real playbook, not a stub: ' + b.manual.length);
  // the SKILL PACKAGE bodies also ride the prompt every run (composed into INSTALLED SKILLS). Keep the worst-case
  // class package well under the 12k compose cap so a class can never crowd out the mission/manual. (Budget reality.)
  let pkgBody = 0;
  for (const slug of b.skills) { const sk = SLUGS.get(slug); if (sk) pkgBody += ('### ' + sk.name + ' -- ' + sk.description + '\n' + sk.body).length; }
  A.ok(pkgBody <= 8000, b.id + ' skill-package body fits the prompt budget (<=8000 chars): ' + pkgBody);
}

/* ---------- 1d. TOOL-REFERENTIAL HONESTY: a manual may only name tools its kit grants ---------- */
// the real wire names a manual might reference, each owned by exactly one kit objectType (registry.js).
// If a manual names one of these, the class MUST carry the granting object — else the playbook is lying.
const TOOL_OWNER = {
  'web_search': 'dish', 'web_fetch': 'dish',
  'fs.read': 'cabinet', 'fs.write': 'cabinet', 'fs.append': 'cabinet', 'fs.edit': 'cabinet', 'fs.search': 'cabinet',
  'shell.exec': 'workbench', 'verify.run': 'workbench',
  'image_generate': 'studio', 'image_analyze': 'studio',
  'notebook.write': 'notebook', 'notebook.read': 'notebook', 'notebook.feedback': 'notebook', 'recall_conversation': 'notebook',
  'spotify_search': 'jukebox', 'spotify_play': 'jukebox',
  'team.dispatch': 'orchestrator', 'team.summon': 'orchestrator', 'routine.create': 'orchestrator'
};
// confirm every owner claim is actually true in the registry (guards the test's own map)
const TOOL_TO_TYPE = {};
for (const [type, grants] of Object.entries(CAP_REGISTRY)) for (const g of grants) TOOL_TO_TYPE[g.tool] = type;
for (const [tool, owner] of Object.entries(TOOL_OWNER)) A.eq(TOOL_TO_TYPE[tool], owner, 'test map matches registry: ' + tool + ' -> ' + owner);
for (const b of builtins) {
  const kit = new Set(b.kit);
  const text = b.manual + ' ' + b.purpose;
  for (const [tool, owner] of Object.entries(TOOL_OWNER)) {
    // word-ish boundary so notebook.read doesn't match notebook.readx etc.
    const re = new RegExp('(^|[^\\w.])' + tool.replace(/[.]/g, '\\.') + '(?![\\w])');
    if (re.test(text)) A.ok(kit.has(owner), b.id + ' manual names "' + tool + '" and its kit grants "' + owner + '"');
  }
}

/* ---------- 1d'. COMMS HONESTY: no class can claim to programmatically SEND to a channel ---------- */
// There is NO agent-callable channel-send tool in CAP_REGISTRY — Discord/Telegram are host-relayed transports,
// not tools an agent invokes. So no manual/purpose may name a send-tool, and the comms classes (which imply
// outward reach) MUST frame it as draft-for-the-Commander, never auto-send. (Capability-honesty rewrite lock.)
const SEND_TOOL_RE = /\b(channel[._]send|discord[._]send|telegram[._]send|message[._]send|send[._]message|broadcast[._]send)\b/i;
for (const b of builtins) {
  const text = (b.manual + ' ' + b.purpose).toLowerCase();
  A.ok(!SEND_TOOL_RE.test(text), b.id + ' names no phantom channel-send tool (none exists in the registry)');
}
// the three outward-comms classes must carry explicit DRAFT-not-send framing (they have no send tool)
for (const id of ['liaison', 'publicist', 'herald']) {
  const b = byId.get(id);
  const text = (b.manual + ' ' + b.purpose + ' ' + b.blurb).toLowerCase();
  A.ok(/draft|go-ahead|do not auto|don't auto|not auto-broadcast|theirs to (publish|send)|without the commander/.test(text),
    id + ' frames outward comms as draft-for-the-Commander (it holds no channel-send tool)');
  A.ok(!/\b(auto-send|send it automatically|post it to (discord|telegram|the channel) yourself)\b/.test(text),
    id + ' never claims to auto-send outward');
}

/* ---------- 1e. every skill a class ships exists + its frontmatter parses ---------- */
const referenced = new Set();
for (const b of builtins) for (const s of b.skills) referenced.add(s);
for (const slug of referenced) {
  const sk = SLUGS.get(slug);
  A.ok(!!sk, 'class-referenced skill exists in the library: ' + slug);
  if (sk) {
    A.ok(sk.name && sk.name.length > 0, slug + ' frontmatter parsed a name');
    A.ok(sk.default === false || sk.default === true, slug + ' frontmatter parsed a boolean default');
    A.ok(Array.isArray(sk.requires), slug + ' frontmatter parsed a requires[] array');
    A.ok(sk.body && sk.body.length > 100, slug + ' has a real procedural body');
  }
}
// the S2 signature skills are all present + honestly grounded (requires are real CAP types)
const NEW_SKILLS = ['source-triangulation', 'feed-watch', 'adversarial-review-pass', 'price-watch',
  'announcement-kit', 'study-plan', 'security-sweep', 'ledger-upkeep', 'translation-pass', 'digest-composer'];
for (const slug of NEW_SKILLS) {
  const sk = SLUGS.get(slug);
  A.ok(!!sk, 'S2 new skill authored: ' + slug);
  if (sk) {
    A.eq(sk.default, false, slug + ' is default:false (arrives via a class package, not globally on)');
    for (const r of (sk.requires || [])) A.ok(CAP_TYPES.has(r), slug + ' requires a real CAP_REGISTRY type: ' + r);
  }
}

/* ---------- 2a. compose(agentSkills): ADD-only union, budget-ordered ---------- */
// a tiny synthetic library so the assertions don't depend on the real recipes' bodies/requires.
const SK = [
  { slug: 'globalon', name: 'GlobalOn', description: '', category: 'A', requires: [], default: true, body: 'G' },
  { slug: 'pkg', name: 'Pkg', description: '', category: 'A', requires: ['cabinet'], default: false, body: 'P' },
  { slug: 'gated', name: 'Gated', description: '', category: 'A', requires: ['workbench'], default: false, body: 'X' },
  { slug: 'off', name: 'Off', description: '', category: 'A', requires: [], default: false, body: 'O' }
];
// baseline: only the default-on skill composes
A.ok(catalog.compose(SK, { placedTypes: ['cabinet', 'workbench'] }).indexOf('GlobalOn') >= 0, 'a default-on skill composes');
A.eq(catalog.compose(SK, { placedTypes: ['cabinet', 'workbench'] }).indexOf('Pkg'), -1, 'a default-off skill does NOT compose without a package/override');

// per-agent package ENABLES pkg (ADD-only) — available because cabinet is placed
const withPkg = catalog.compose(SK, { placedTypes: ['cabinet', 'workbench'], agentSkills: ['pkg'] });
A.ok(withPkg.indexOf('Pkg') >= 0, 'agentSkills enables a package skill for THIS agent');
A.ok(withPkg.indexOf('GlobalOn') >= 0, 'agentSkills is ADD-only — the globally-on skill is still present');

// ADD-only: a per-agent enable can NEVER disable a globally-enabled skill (there is no agent-side "off")
const cantDisable = catalog.compose(SK, { placedTypes: ['cabinet'], overrides: { globalon: true }, agentSkills: ['off'] });
A.ok(cantDisable.indexOf('GlobalOn') >= 0, 'a per-agent package cannot disable a globally-enabled skill');

// still availability-gated: pkg requires cabinet — absent, the package can't force it in
A.eq(catalog.compose(SK, { placedTypes: [], agentSkills: ['pkg'] }).indexOf('Pkg'), -1, 'agentSkills is still gated by placedTypes (object=capability)');

// budget ordering: under a tight budget, the class PACKAGE composes before a global extra
const bigLib = [
  { slug: 'g1', name: 'G1', description: '', category: 'A', requires: [], default: true, body: 'x'.repeat(200) },
  { slug: 'p1', name: 'P1', description: '', category: 'A', requires: [], default: false, body: 'y'.repeat(200) }
];
const tight = catalog.compose(bigLib, { placedTypes: [], agentSkills: ['p1'], budget: 260 });
A.ok(tight.indexOf('P1') >= 0, 'under a tight budget the agent package composes first (P1 kept)');
A.eq(tight.indexOf('G1'), -1, 'the global extra (G1) is the one truncated, not the class package');

/* ---------- 2b. sidecar roster passthrough (source-level: additive fields carried + persisted) ---------- */
const idx = fs.readFileSync(path.join(__dirname, '../sidecar/index.js'), 'utf8');
const repl = idx.slice(idx.indexOf('function replaceAgentRoster('), idx.indexOf('function loadAgentRoster('));
A.ok(/skills:\s*Array\.isArray\(a && a\.skills\)/.test(repl), 'replaceAgentRoster passes through per-agent skills[]');
A.ok(/reasoningEffort:\s*\(a && a\.reasoningEffort\)/.test(repl), 'replaceAgentRoster passes through reasoningEffort');
const save = idx.slice(idx.indexOf('function saveAgentRoster('), idx.indexOf('function saveAgentRoster(') + 600);
A.ok(/skills:\s*Array\.isArray\(a\.skills\)/.test(save), 'saveAgentRoster persists skills (old rosters without it still load)');
// injection site passes the roster record's skills as agentSkills; effort precedence adds the roster fallback
A.ok(/agentSkills:\s*agentSkills/.test(idx), 'the skill-injection site passes the running agent\'s package as agentSkills');
A.ok(/rosterIdent && rosterIdent\.reasoningEffort/.test(idx), 'reasoning-effort precedence falls back to the roster record');

/* ---------- 3. SOURCE-LEVEL: the browser summon path applies the loadout honestly ---------- */
const app = fs.readFileSync(path.join(__dirname, '../frontend/app/app.js'), 'utf8');
const build = fs.readFileSync(path.join(__dirname, '../frontend/app/build.js'), 'utf8');

// summonAgent applies the loadout onto the record + requisitions the kit
A.ok(/applyLoadout\(a, spec, pin\)/.test(app), 'summon applies the class loadout (applyLoadout) with the explicit bay pin');
A.ok(/requisitionKit\(a, spec\)/.test(app), 'summon requisitions the class kit');
// applyLoadout resolves the tier via the seam, sets effort + per-agent skills
const loadoutSeg = app.slice(app.indexOf('function applyLoadout('), app.indexOf('function requisitionKit('));
A.ok(/resolveTierModel\(/.test(loadoutSeg), 'applyLoadout resolves the model tier through the seam');
A.ok(/a\.reasoningEffort\s*=\s*spec\.reasoningEffort/.test(loadoutSeg), 'applyLoadout sets the applied reasoning effort');
// DEFAULTS-NEVER-LOCKS at the creation seam: an EXPLICIT bay model/effort pick (agent-model-select's
// spec.modelPin) must beat the class-tier default — the class must not clobber a hand-chosen model/effort.
A.ok(/if\s*\(!\(pin\s*&&\s*pin\.model\)\)/.test(loadoutSeg), 'applyLoadout: explicit bay model pin beats the class tier default');
A.ok(/spec\.reasoningEffort\s*&&\s*!\(pin\s*&&\s*pin\.effort\)/.test(loadoutSeg), 'applyLoadout: explicit bay effort pin beats the class effort default');
A.ok(/a\.skills\s*=\s*out/.test(loadoutSeg), 'applyLoadout records the per-agent skill package');

// requisitionKit degrades gracefully (collects skipped, never throws) and goes through Build.requisitionForAgent
const kitSeg = app.slice(app.indexOf('function requisitionKit('), app.indexOf('function requisitionKit(') + 1400);
A.ok(/Build\.requisitionForAgent/.test(kitSeg), 'the kit is placed via Build.requisitionForAgent (the real path)');
A.ok(/skipped\.push/.test(kitSeg), 'requisitionKit collects what did not fit (graceful degrade, no crash)');
A.ok(/try\s*\{[\s\S]*?catch/.test(kitSeg), 'requisitionKit wraps each placement so one failure never breaks summon');

// pushRoster + serialize carry the additive fields to the backend + to disk
A.ok(/skills:\s*Array\.isArray\(a\.skills\)\s*\?\s*a\.skills\s*:\s*\[\][\s\S]{0,80}reasoningEffort:\s*a\.reasoningEffort/.test(app),
  'pushRoster sends per-agent skills + reasoningEffort to /api/roster');

// build.requisitionForAgent is the REAL validated placement path, room-scoped, idempotent, non-throwing
A.ok(/function requisitionForAgent\(/.test(build), 'Build.requisitionForAgent exists');
const rfa = build.slice(build.indexOf('function requisitionForAgent('), build.indexOf('const api = {', build.indexOf('function requisitionForAgent(')));
A.ok(/findPlaceableTileInRoom\(/.test(rfa), 'requisitionForAgent places at a VALIDATED tile scoped to the agent room');
A.ok(/st\.addProp\(/.test(rfa), 'requisitionForAgent goes through the real station.addProp (object=capability stays honest)');
A.ok(/no-room/.test(rfa), 'requisitionForAgent degrades honestly when the agent has no workstation yet');
A.ok(/already/.test(rfa), 'requisitionForAgent is idempotent — it never stacks a cap already in the room');
A.ok(/requisitionForAgent\s*[},]/.test(build.slice(build.indexOf('const api = {'))), 'requisitionForAgent is exported on the Build api');

// the room-scoped tile finder respects the room boundary (roomAt match)
A.ok(/function findPlaceableTileInRoom\([\s\S]*?roomAt\(tx, ty\) === room\.id/.test(build), 'findPlaceableTileInRoom stays inside the agent room');

/* ---------- team.summon class list is composed from the shared catalog (no hardcoded prose) ---------- */
const orch = fs.readFileSync(path.join(__dirname, '../sidecar/tools/builtin/orchestration.js'), 'utf8');
A.ok(/deps\.classes[\s\S]{0,120}\.map\(c => c && c\.id\)/.test(orch), 'team.summon SPEC_IDS is composed from the injected shared catalog');
A.ok(/SPECIALIST_CLASSES\s*=\s*\(sharedSpecialties\.BUILTINS/.test(idx), 'the sidecar composes the class list from the shared catalog');
A.ok(/classes:\s*SPECIALIST_CLASSES/.test(idx), 'the shared class list is injected into the orchestration tools');

/* ---------- 4. KIT-ARRIVAL GAP: deferred kit delivery on room-assign (adversarial review fix) ---------- */
// 4a. FUNCTIONAL (real WorldModel): the room-arrival seam + the idempotence PREMISE requisitionForAgent relies on.
// A fresh agent has NO room until a bay bound to it is placed; once placed, agentRoomId resolves and bayObjects
// dedups a capability — so re-requisitioning a cap already in the room is a no-op (the {already:true} guard holds).
const WorldModel = require('../frontend/app/worldmodel.js');
{
  const m = WorldModel.create ? WorldModel.create() : null;
  A.ok(m, 'WorldModel.create() loads headless');
  // a fresh agent with no bay has NO room -> requisitionForAgent would return no-room -> kit goes pending
  A.eq(m.agentRoomId('kituser'), null, 'a fresh agent (no bay) has no room — kit cannot arrive at summon');
  const roomId = m.spawnRoomId();   // the default station ships one hab room; use it (a real room the bay can land in)
  A.ok(roomId, 'the default station has a room the agent can be seated in');
  const bay = m.addProp({ t: 'bay', x: 3, y: 3, w: 2, h: 2, agentId: 'kituser' });
  A.ok(bay.ok, 'a bay bound to the agent places');
  A.eq(m.agentRoomId('kituser'), roomId, 'binding a bay gives the agent a room — the deferred-delivery trigger');
  // place the canonical cabinet prop (war_intelcab -> cabinet) IN the room; bayObjects should surface 'cabinet'
  const cab = m.addProp({ t: 'war_intelcab', x: 6, y: 6, w: 1, h: 1 });
  A.ok(cab.ok, 'a cabinet prop places in the room');
  const caps1 = m.bayObjects('kituser');
  A.ok(caps1.indexOf('cabinet') >= 0, 'bayObjects surfaces the placed cabinet capability');
  // idempotence premise: a SECOND cabinet in the same room does not double the capability -> requisitionForAgent's
  // `already` short-circuit (which reads bayObjects) correctly prevents a duplicate placement.
  m.addProp({ t: 'safe', x: 8, y: 8, w: 1, h: 1 });   // also maps to 'cabinet'
  const caps2 = m.bayObjects('kituser').filter(c => c === 'cabinet');
  A.eq(caps2.length, 1, 'a capability is deduped in a room — the idempotent `already` guard never stacks duplicates');
}

// 4b. SOURCE: summon records the undelivered kit as pendingKit; it persists + rehydrates + is exported for delivery.
A.ok(/setPendingKit\(a, pending\)/.test(app), 'requisitionKit records the still-missing (retryable) kit as pendingKit');
A.ok(/KIT_RETRYABLE\s*=\s*\{[^}]*'no-room'/.test(app), 'only retryable misses (no-room/no-valid-tile/…) go pending — permanent ones never nag');
A.ok(/function deliverPendingKit\(agentId\)/.test(app), 'App.deliverPendingKit drains an agent\'s pending kit once it has a room');
const dpk = app.slice(app.indexOf('function deliverPendingKit('), app.indexOf('function deliverPendingKit(') + 1200);
A.ok(/Build\.requisitionForAgent/.test(dpk), 'deliverPendingKit goes through the SAME validated placement path');
A.ok(/res\.ok\)\s*delivered\.push/.test(dpk), 'deliverPendingKit treats ok (placed OR already-present) as delivered — idempotent');
A.ok(/KIT_RETRYABLE\[res\.reason\]\)\s*stillPending\.push/.test(dpk), 'deliverPendingKit re-queues only still-retryable misses; drops permanent ones');
A.ok(/pendingKit:\s*Array\.isArray\(a\.pendingKit\)/.test(app), 'serializeAgentLite persists pendingKit (survives reload)');
A.ok(/pendingKit:\s*Array\.isArray\(s\.pendingKit\)/.test(app), 'rehydrateRoster restores pendingKit');
A.ok(/deliverPendingKit,/.test(app), 'App exports deliverPendingKit');
A.ok(/onAgentRoomAssigned:\s*deliverPendingKit/.test(app), 'Build.init wires deliverPendingKit as the room-assign hook');
A.ok(/for \(const a of liveAgents\(\)\) if \(Array\.isArray\(a\.pendingKit\)[\s\S]{0,60}deliverPendingKit\(a\.id\)/.test(app),
  'on load, any resumed agent with a room drains its pending kit');
// build.js fires the room-assign hook after BOTH pickers bind an agent (bay + workstation)
const bayOk = build.slice(build.indexOf("#bay-ok"), build.indexOf("#bay-ok") + 700);
A.ok(/onAgentRoomAssigned\(res\.agentId\)/.test(bayOk), 'the BAY picker fires onAgentRoomAssigned after a successful bind');
const wsOk = build.slice(build.indexOf("#ws-ok"), build.indexOf("#ws-ok") + 700);
A.ok(/onAgentRoomAssigned\(res\.agentId\)/.test(wsOk), 'the WORKSTATION picker fires onAgentRoomAssigned after a successful bind');

/* ---------- 5. EFFORT PRECEDENCE: a dispatched worker runs at its OWN class effort, not the lead's ---------- */
// runOnce precedence: explicit run-option > roster (class) > provider default (source).
A.ok(/o\.reasoningEffort[\s\S]{0,120}rosterIdent && rosterIdent\.reasoningEffort/.test(idx),
  'runOnce effort precedence: explicit run-option, then the roster (class) record, then provider default');
// the dispatch worker MUST resolve effort from the WORKER's roster identity — else the class effort is dead
// (the lead always passes a truthy effort, which would shadow the roster fallback). Both dispatch paths fixed.
A.ok(/reasoningEffort:\s*\(job\.ident && job\.ident\.reasoningEffort\)\s*\|\|\s*reasoningEffort/.test(orch),
  'team.dispatch (immediate) runs each worker at its OWN class reasoning effort, not the lead\'s');
A.ok(/reasoningEffort:\s*\(ident && ident\.reasoningEffort\)\s*\|\|\s*reasoningEffort/.test(orch),
  'team.dispatch (queued/recap) runs each worker at its OWN class reasoning effort, not the lead\'s');

/* ---------- 6. OLD-SAVE COMPAT: rosters/records without the new fields load unchanged ---------- */
A.ok(/skills:\s*Array\.isArray\(a && a\.skills\)\s*\?[\s\S]{0,120}:\s*\[\]/.test(repl), 'replaceAgentRoster coerces a missing skills -> [] (old rosters load)');
A.ok(/reasoningEffort:\s*\(a && a\.reasoningEffort\)\s*\?\s*String\(a\.reasoningEffort\)\s*:\s*null/.test(repl), 'replaceAgentRoster coerces a missing reasoningEffort -> null (no undefined leaks into a run)');
// the frontend catalog wrapper defaults customs/old specs to empty loadouts (no crash on a pre-loadout custom)
for (const c of [{ name: 'Legacy', purpose: 'x' }]) {
  const norm = S.saveCustom(c);
  A.ok(Array.isArray(norm.kit) && norm.kit.length === 0, 'a pre-loadout custom spec loads with an empty kit (no crash)');
  A.eq(norm.reasoningEffort, null, 'a pre-loadout custom spec has a null effort');
  S.removeCustom(norm.id);
}

/* ============================================================================================
   S3 — UI: the loadout is VISIBLE (dossier) + CONFIGURABLE (custom builder) + a tier->model seam.
   Like S1/S3 above, the browser modules are IIFEs over live DOM, so we source-lock the honesty-critical
   wiring: labels/grants resolve from the LIVE catalog (never hardcoded), the custom builder round-trips the
   loadout into the saved spec, and resolveTierModel consults the persisted tier->model map.
   ============================================================================================ */
const mkt = fs.readFileSync(path.join(__dirname, '../frontend/app/marketplace.js'), 'utf8');
const sui = fs.readFileSync(path.join(__dirname, '../frontend/app/stationui.js'), 'utf8');

/* ---------- S3a. DOSSIER: kit + skill package render from LIVE sources (no hardcoded prop labels) ---------- */
// the kit block resolves each objectType's prop label from the LIVE catalog (PropSprites.CATALOG via
// WorldModel.CAP_PROP_MAP) and its grant from WorldModel's owned CAP_LABEL — never a hardcoded prop name.
A.ok(/function kitBlockHTML\(s\)/.test(mkt), 'the dossier has a STANDARD ISSUE KIT block');
A.ok(/STANDARD ISSUE KIT/.test(mkt), 'the dossier labels the kit section "STANDARD ISSUE KIT"');
A.ok(/function kitPropLabel\(objType\)/.test(mkt), 'kit labels resolve through kitPropLabel (from the live catalog)');
const kpl = mkt.slice(mkt.indexOf('function kitPropLabel('), mkt.indexOf('function kitPropLabel(') + 900);
A.ok(/PropSprites\.CATALOG/.test(kpl), 'kitPropLabel reads the LIVE PropSprites catalog for the prop label (never hardcoded)');
A.ok(/CAP_PROP_MAP/.test(kpl), 'kitPropLabel maps the objectType through WorldModel.CAP_PROP_MAP (the owned source)');
A.ok(/WorldModel/.test(mkt) && /CAP_LABEL/.test(mkt), 'the dossier resolves capability grants from WorldModel.CAP_LABEL (the owned power-word source)');
// the SKILL PACKAGE block resolves names/descriptions from the /api/skills catalog the SKILLS window uses.
A.ok(/function skillPackageHTML\(s\)/.test(mkt), 'the dossier has a SKILL PACKAGE block');
A.ok(/SKILL PACKAGE/.test(mkt), 'the dossier labels the skills section "SKILL PACKAGE"');
A.ok(/function loadSkillCatalog\(\)/.test(mkt) && /fetch\('\/api\/skills'\)/.test(mkt),
  'skill names/descriptions come from the live /api/skills catalog (the SKILLS window\'s source)');
A.ok(/function hydrateSkillRows\(\)/.test(mkt) && /hydrateSkillRows\(\)/.test(mkt.slice(mkt.indexOf('function renderDossier'))),
  'the dossier hydrates real skill names async once the catalog resolves');
// CLEARANCE honesty: the pips read as advisory model (station default) while EFFORT is labelled applied-at-summon.
A.ok(/model: station default/.test(mkt), 'the CLEARANCE row is honest — the model is the station default (advisory pip)');
A.ok(/applied at summon/.test(mkt), 'the EFFORT row is honest — the reasoning effort is what summon APPLIES');

/* ---------- S3b. CUSTOM BUILDER: kit/skills/effort round-trip into the saved custom spec ---------- */
// the builder holds picked-loadout state and folds it into the spec passed to Specialties.saveCustom.
A.ok(/let buildKit = \[\], buildSkills = \[\], buildEffort = null/.test(mkt), 'the custom builder tracks picked kit/skills/effort');
A.ok(/function buildKitChipsHTML\(\)/.test(mkt), 'the builder renders kit picker chips');
A.ok(/KIT_PICKABLE = \['dish', 'cabinet', 'notebook', 'workbench', 'studio'\]/.test(mkt),
  'the kit picker offers the auto-requisitionable caps only (computer/connector are manual-bind, excluded)');
A.ok(/data-skill=/.test(mkt) && /loadSkillCatalog\(\)\.then/.test(mkt.slice(mkt.indexOf('function wireBuildForm'))),
  'the skill picker is populated from the live skill catalog');
A.ok(/data-effort=/.test(mkt), 'the builder has a reasoning-effort selector');
// the CREATE handler passes kit/skills/effort into saveCustom (round-trip).
const createSeg = mkt.slice(mkt.indexOf("const create = stage.querySelector('.mkt-do-build')"), mkt.indexOf("stage.querySelector('#mkt-b-name'); if (nameIn)"));
A.ok(/kit:\s*buildKit\.slice\(\)/.test(createSeg), 'CREATE folds the picked kit into the saved spec');
A.ok(/skills:\s*buildSkills\.slice\(\)/.test(createSeg), 'CREATE folds the picked skill package into the saved spec');
A.ok(/reasoningEffort:\s*buildEffort/.test(createSeg), 'CREATE folds the picked effort into the saved spec');
// FUNCTIONAL round-trip through the real Specialties store: a saved custom carrying a loadout normalizes + persists it.
{
  const saved = S.saveCustom({ name: 'Loadout QA', purpose: 'test', kit: ['dish', 'notebook', 'dish'], skills: ['web-research', 'web-research'], reasoningEffort: 'high' });
  A.ok(saved.kit.indexOf('dish') >= 0 && saved.kit.indexOf('notebook') >= 0, 'a custom class round-trips its picked kit');
  A.eq(saved.kit.length, 2, 'the saved kit is deduped (dish listed once)');
  A.ok(saved.skills.indexOf('web-research') >= 0, 'a custom class round-trips its picked skill package');
  A.eq(saved.skills.length, 1, 'the saved skill package is deduped');
  A.eq(saved.reasoningEffort, 'high', 'a custom class round-trips its picked reasoning effort');
  // and it survives a reload (re-normalized from the store shape)
  const round = S.get(saved.id);
  A.ok(round && round.kit.length === 2 && round.reasoningEffort === 'high', 'the loadout persists on the saved custom record');
  // a garbage effort normalizes to null (never leaks an unknown level into a run)
  const bad = S.saveCustom({ name: 'Bad Effort', purpose: 'x', reasoningEffort: 'extreme' });
  A.eq(bad.reasoningEffort, null, 'an unknown effort normalizes to null');
  S.removeCustom(saved.id); S.removeCustom(bad.id);
}

/* ---------- S3c. TIER->MODEL: settings persist the map + resolveTierModel consults it ---------- */
// the seam is now filled: resolveTierModel reads a persisted tier->model map (a pinned tier wins; else base model).
A.ok(/TIER_MODELS_KEY = 'starnet\.tierModels\.v1'/.test(app), 'app.js defines the tier->model store key');
const rtm = app.slice(app.indexOf('function resolveTierModel('), app.indexOf('function resolveTierModel(') + 400);
A.ok(/tierModelMap\(\)\[tier\]/.test(rtm), 'resolveTierModel consults the persisted tier->model map (the S1 seam is filled)');
A.ok(/return baseModel \|\|/.test(rtm), 'an unpinned tier still falls back to the base/station-default model (default unchanged)');
// the SETTINGS MODELS section adds the CLASS TIER MODELS mapping + wires it to the SAME localStorage key.
A.ok(/CLASS TIER MODELS/.test(sui), 'SETTINGS surfaces a CLASS TIER MODELS mapping');
A.ok(/TIER_MODELS_KEY = 'starnet\.tierModels\.v1'/.test(sui), 'the settings writer uses the SAME key app.js reads (no new plumbing)');
A.ok(/function wireTierModels\(body\)/.test(sui) && /wireTierModels\(host\)/.test(sui), 'the tier-model picker is wired into buildSettings');
A.ok(/models\/openrouter/.test(sui.slice(sui.indexOf('function wireTierModels'))), 'the tier-model selects are filled from the live model catalog');
const tmSeg = sui.slice(sui.indexOf('function wireTierModels'), sui.indexOf('function wireTierModels') + 2200);
A.ok(/writeTierModels\(map\)/.test(tmSeg), 'a tier-model pick persists to the store on change');

A.report('class-loadouts');
