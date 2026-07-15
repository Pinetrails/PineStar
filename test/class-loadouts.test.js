/* node test/class-loadouts.test.js — Class Loadouts (the shared-gear model).

   A class = model tier + reasoning effort + skill package + the SHARED STATION GEAR it draws on. Andrew's rule
   (2026-07-02): "the only prop a specialized or secondary agent needs is its own desk; it's allowed to use other
   props with the overseer." So a class's `kit` is NOT issued per-agent — it names shared station gear used under
   the overseer (informational in the dossier, and the gate for the class's skill availability). Two halves,
   matching kitout.test.js's discipline:
     1. GROUNDED-CATALOG unit tests (real assertions on pure modules): the shared catalog is well-formed and
        HONEST — every kit objectType is a real CAP_REGISTRY key, every skill slug is a real bundled recipe, and
        every skill's `requires` is satisfied by its class's declared gear (Law 4: grounded classes only).
     2. UNIT tests for the wiring the backend depends on: catalog.compose(agentSkills) is an ADD-only union that
        respects the budget with the package first; the sidecar roster passes skills/effort through; and a
        specialist's skills gate on STATION-WIDE gear (not its desk-room) so a desk-only specialist still gets them.
     3. SOURCE-LEVEL invariants for the browser-only summon path (app.js / build.js are IIFEs over live DOM, so —
        like kitout.test.js — we lock the honesty-critical wiring by reading the source): NO per-agent placement. */
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
const archetypes = S.archetypes();
// EVERY law below holds for the full catalog — the curated roster AND the deep-cut archetype pool (an
// archetype is a real, summonable class; demoting it off the default roster demotes nothing about its rigor).
const CATALOG = builtins.concat(archetypes);
A.ok(CATALOG.length >= 11, 'the class catalog ships every class (>= 11), got ' + CATALOG.length);

for (const b of CATALOG) {
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

/* ---------- 1b. RECURATED CONTENT: 12 curated + 9 archetypes, seals/codes, prompt-size sanity ----------
   Recuration 2026-07-14: the default roster was trimmed from 18 to 12 distinct majority-use jobs; the 9
   demoted deep cuts became the ARCHETYPE pool (off the roster, never gated, seeds for the scout's
   personalized prospect minting). Three genuinely new practical classes joined the curated 12. */
const classicons = require('../frontend/app/classicons.js');
A.eq(builtins.length, 12, 'the curated roster ships exactly 12 classes');
A.eq(archetypes.length, 9, 'the archetype pool holds the 9 deep cuts');
const CURATED = ['researcher', 'engineer', 'operator', 'scribe', 'analyst', 'scout', 'designer', 'chief', 'tutor', 'navigator', 'curator', 'muse'];
A.eq(builtins.map(b => b.id).sort().join(','), CURATED.slice().sort().join(','), 'the curated roster is exactly the 12 majority-use classes');
const ARCH_IDS = ['reviewer', 'archivist', 'liaison', 'broker', 'publicist', 'auditor', 'bookkeeper', 'translator', 'herald'];
A.eq(archetypes.map(a => a.id).sort().join(','), ARCH_IDS.slice().sort().join(','), 'the archetype pool is exactly the 9 demoted deep cuts');
for (const id of ARCH_IDS) A.ok(!builtins.some(b => b.id === id), 'archetype is OFF the default roster: ' + id);
// no id/name collision across the two shelves (an archetype must never shadow a curated class)
const NEW_CLASSES = ['navigator', 'curator', 'muse'];
const byId = new Map(CATALOG.map(b => [b.id, b]));
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
// unique ids + unique 3-letter class codes across BOTH shelves (a code collision would mis-stamp a coin)
const ids = CATALOG.map(b => b.id);
A.eq(new Set(ids).size, ids.length, 'every class id is unique (curated + archetypes)');
const codes = CATALOG.map(b => classicons.code(b.id));
for (const c of codes) A.ok(/^[A-Z0-9]{3}$/.test(c), 'class code is a real 3-letter stamp: ' + c);
A.eq(new Set(codes).size, codes.length, 'every class code is unique (no coin collision): ' + codes.join(','));
// EVERY catalog id has a bespoke seal, and EVERY seal maps to a catalog id (no orphans either way)
for (const b of CATALOG) A.ok(!!classicons.svg(b.id), 'class has a bespoke seal icon: ' + b.id);
const iconIds = Object.keys(classicons.ICONS);
const catIds = new Set(ids);
for (const iid of iconIds) A.ok(catIds.has(iid), 'seal icon maps to a real catalog class (no orphan seal): ' + iid);
A.eq(iconIds.length, CATALOG.length, 'exactly one seal per class (' + iconIds.length + ' seals, ' + CATALOG.length + ' classes)');
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

/* ---------- 1b''. TYPED ASCII MARKS (premium bay pass): the bay's rendered emblem is TYPED, not drawn ----
   The bay renders ClassIcons.ascii() for every class (the SVG seals stay as the mission art + vector
   fallback). Laws: every catalog class has a bespoke mark; every mark maps back to a catalog class (no
   orphans); a mark is exactly 3 rows of <=6 columns of PRINTABLE PURE ASCII (0x20-0x7E) so every font on
   every machine types it identically; and no two classes share a mark (identity, not decoration). */
for (const b of CATALOG) {
  const m = classicons.ascii(b.id);
  A.ok(Array.isArray(m) && m.length === 3, b.id + ' has a 3-row typed ASCII mark');
  if (m) for (const row of m) {
    A.ok(typeof row === 'string' && row.length >= 1 && row.length <= 6, b.id + ' mark row is 1-6 columns: "' + row + '"');
    A.ok(/^[\x20-\x7E]*$/.test(row), b.id + ' mark row is pure printable ASCII: "' + row + '"');
  }
}
const asciiIds = Object.keys(classicons.ASCII);
for (const aid of asciiIds) A.ok(catIds.has(aid), 'ASCII mark maps to a real catalog class (no orphan mark): ' + aid);
A.eq(asciiIds.length, CATALOG.length, 'exactly one typed mark per class (' + asciiIds.length + ' marks, ' + CATALOG.length + ' classes)');
const markKeys = CATALOG.map(b => classicons.ascii(b.id).join('\n'));
A.eq(new Set(markKeys).size, markKeys.length, 'every typed mark is unique (no two classes share an emblem)');
// the bay actually renders the typed mark (never silently regresses to the coin for classes)
const mktSrc = fs.readFileSync(path.join(__dirname, '../frontend/app/marketplace.js'), 'utf8');
A.ok(/ClassIcons\.ascii\s*\(/.test(mktSrc) && /mkt-amark/.test(mktSrc),
  'the bay renders ClassIcons.ascii() as the class emblem (.mkt-amark)');

/* ---------- 1b'. DISTINCTNESS: a beginner must be able to tell the classes apart at pick-time ---------- */
// taglines + blurbs are unique across BOTH shelves (no two classes present as the same thing in the bay).
const taglines = CATALOG.map(b => b.tagline.trim().toLowerCase());
A.eq(new Set(taglines).size, taglines.length, 'every class tagline is unique');
const blurbs = CATALOG.map(b => b.blurb.trim().toLowerCase());
A.eq(new Set(blurbs).size, blurbs.length, 'every class blurb is unique');
// the confusable pair broker/scout both touch prices — the broker blurb must DRAW the boundary (decide vs watch)
// so a beginner can predict which to pick. (Adversarial-review fix: broker retuned off the word "scout".)
const brokerBlurb = byId.get('broker').blurb.toLowerCase();
A.ok(/scout/.test(brokerBlurb) && /(decide|call|buy|which)/.test(brokerBlurb),
  'the broker blurb explicitly contrasts itself with the scout (decide-now vs watch-and-alert)');
A.ok(!/scout/.test(byId.get('broker').tagline.toLowerCase()),
  'the broker tagline no longer overloads the word "scout" (collided with the scout class)');

/* ---------- 1c. PROMPT-SIZE SANITY: manuals/purposes are injected every run — keep them tight ---------- */
for (const b of CATALOG) {
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
for (const b of CATALOG) {
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
for (const b of CATALOG) {
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
for (const b of CATALOG) for (const s of b.skills) referenced.add(s);
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
// the S2 + recuration signature skills are all present + honestly grounded (requires are real CAP types)
const NEW_SKILLS = ['source-triangulation', 'feed-watch', 'adversarial-review-pass', 'price-watch',
  'announcement-kit', 'study-plan', 'security-sweep', 'ledger-upkeep', 'translation-pass', 'digest-composer',
  'itinerary-planning', 'file-curation'];
for (const slug of NEW_SKILLS) {
  const sk = SLUGS.get(slug);
  A.ok(!!sk, 'S2 new skill authored: ' + slug);
  if (sk) {
    A.eq(sk.default, false, slug + ' is default:false (arrives via a class package, not globally on)');
    for (const r of (sk.requires || [])) A.ok(CAP_TYPES.has(r), slug + ' requires a real CAP_REGISTRY type: ' + r);
  }
}

/* ---------- 1f. ARCHETYPE SEAM: off the default roster, never gated ---------- */
// get() resolves an archetype id — an old save, a scout draft, or a summon-by-id keeps working after the trim.
const arch = S.get('translator');
A.ok(arch && arch.id === 'translator' && arch.custom === false, 'Specialties.get resolves an archetype id');
A.ok(!S.builtins().some(b => b.id === 'translator'), 'builtins() (the default roster) excludes archetypes');
A.ok(!S.list().some(b => b.id === 'translator'), 'list() (roster + customs) excludes archetypes — they are asked for explicitly');
A.eq(S.archetypes().length, 9, 'archetypes() exposes the pool');
const archCompose = S.compose('reviewer');
A.ok(archCompose && archCompose.purpose.length > 0 && archCompose.manual.length > 0, 'compose() works on an archetype (summonable as-is, same deploy path)');
// a custom can never shadow an archetype id (uniqueId consults get(), which now spans both shelves)
{
  const clash = S.saveCustom({ name: 'Broker', purpose: 'x' });
  A.ok(clash.id !== 'broker', 'a saved custom never collides with an archetype id: ' + clash.id);
  S.removeCustom(clash.id);
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

// summonAgent applies the loadout onto the record (model/effort/skills). Under the shared-gear model it does NOT
// place any per-agent props — the class's `kit` is shared station gear it draws on under the overseer.
A.ok(/applyLoadout\(a, spec, pin\)/.test(app), 'summon applies the class loadout (applyLoadout) with the explicit bay pin');
// applyLoadout resolves the tier via the seam, sets effort + per-agent skills
const loadoutSeg = app.slice(app.indexOf('function applyLoadout('), app.indexOf('function allocAgentId('));
A.ok(/resolveTierModel\(/.test(loadoutSeg), 'applyLoadout resolves the model tier through the seam');
A.ok(/a\.reasoningEffort\s*=\s*spec\.reasoningEffort/.test(loadoutSeg), 'applyLoadout sets the applied reasoning effort');
// DEFAULTS-NEVER-LOCKS at the creation seam: an EXPLICIT bay model/effort pick (agent-model-select's
// spec.modelPin) must beat the class-tier default — the class must not clobber a hand-chosen model/effort.
A.ok(/if\s*\(!\(pin\s*&&\s*pin\.model\)\)/.test(loadoutSeg), 'applyLoadout: explicit bay model pin beats the class tier default');
A.ok(/spec\.reasoningEffort\s*&&\s*!\(pin\s*&&\s*pin\.effort\)/.test(loadoutSeg), 'applyLoadout: explicit bay effort pin beats the class effort default');
A.ok(/a\.skills\s*=\s*out/.test(loadoutSeg), 'applyLoadout records the per-agent skill package');

// SHARED-GEAR MODEL (Andrew's rule): the per-agent placement machinery is GONE — no kit is issued to an agent.
// The only per-agent object is its desk; capabilities are station-level shared gear used under the overseer.
A.ok(!/requisitionKit/.test(app), 'app.js no longer requisitions a per-agent kit (shared-gear model)');
A.ok(!/deliverPendingKit/.test(app), 'app.js no longer defers/delivers a per-agent kit (shared-gear model)');
A.ok(!/pendingKit/.test(app), 'the pendingKit field is gone from serialize/rehydrate/exports (no per-agent kit state)');
A.ok(!/requisitionForAgent/.test(build), 'build.js no longer exposes per-agent prop placement (Build.requisitionForAgent removed)');
A.ok(!/onAgentRoomAssigned/.test(build), 'build.js no longer fires a room-assign kit-delivery hook (dead code removed)');

// the summon loadout beat is honest about shared gear: it names the STATION GEAR the class draws on that is
// MISSING (add it in REFIT), and never claims a kit "arrives" at a per-agent workstation.
const summarySeg = app.slice(app.indexOf('function loadoutSummary('), app.indexOf('function loadoutSummary(') + 900);
A.ok(/stationGearTypes\(\)/.test(summarySeg), 'loadoutSummary checks the class gear against the STATION (station-wide), not the agent room');
A.ok(/add .* in REFIT/.test(summarySeg), 'loadoutSummary tells the Commander to add missing station gear in REFIT');
A.ok(!/arrives when it gets a workstation/.test(app), 'the summon copy no longer promises a kit arrives at a workstation');
// stationGearTypes reads the station-wide caps (the shared source the run\'s skill availability uses)
A.ok(/function stationGearTypes\(\)[\s\S]{0,200}World\.stationCaps/.test(app), 'stationGearTypes reads World.stationCaps (station-wide shared gear)');

// pushRoster + serialize carry the additive fields to the backend + to disk (skills + effort survive the rework)
A.ok(/skills:\s*Array\.isArray\(a\.skills\)\s*\?\s*a\.skills\s*:\s*\[\][\s\S]{0,80}reasoningEffort:\s*a\.reasoningEffort/.test(app),
  'pushRoster sends per-agent skills + reasoningEffort to /api/roster');

/* ---------- team.summon class list is composed from the shared catalog (no hardcoded prose) ---------- */
const orch = fs.readFileSync(path.join(__dirname, '../sidecar/tools/builtin/orchestration.js'), 'utf8');
A.ok(/deps\.classes[\s\S]{0,120}\.map\(c => c && c\.id\)/.test(orch), 'team.summon SPEC_IDS is composed from the injected shared catalog');
A.ok(/SPECIALIST_CLASSES\s*=\s*\(sharedSpecialties\.BUILTINS/.test(idx), 'the sidecar composes the class list from the shared catalog');
A.ok(/classes:\s*SPECIALIST_CLASSES/.test(idx), 'the shared class list is injected into the orchestration tools');

/* ---------- 4. SHARED-GEAR SKILL AVAILABILITY: a desk-only specialist still gets its class skills ---------- */
// THE POINT of the rework: a specialist owns only a desk, but its SKILL PACKAGE (recipes) must reach its runs when
// the STATION has the required shared gear. So the interactive run gates skills on STATION-WIDE gear, not the
// agent's own (desk-only) room — while TOOL reach stays room-scoped (resolveTools untouched).
// 4a. the browser sends a station-wide gear list (World.stationCaps) alongside the room-scoped `placed`.
A.ok(/stationCaps:/.test(fs.readFileSync(path.join(__dirname, '../frontend/app/world.js'), 'utf8')),
  'World exposes stationCaps() — every capability placed anywhere on the station (station-wide shared gear)');
const chat = fs.readFileSync(path.join(__dirname, '../frontend/app/chat.js'), 'utf8');
A.ok(/stationPlaced:\s*\(typeof World[\s\S]{0,80}World\.stationCaps\(\)/.test(chat),
  'the run sends stationPlaced = World.stationCaps() for SKILL availability (tools stay `placed`/room-scoped)');
const harness = fs.readFileSync(path.join(__dirname, '../frontend/app/harness.js'), 'utf8');
A.ok(/reqBody\.stationPlaced = stationPlaced/.test(harness), 'harness.chat forwards stationPlaced to /api/run');
// 4b. the sidecar parses stationPlaced, threads it as stationObjects, and unions it into the skill placedTypes ONLY.
A.ok(/const stationObjects = \(body && Array\.isArray\(body\.stationPlaced\)\)/.test(idx), 'the sidecar parses body.stationPlaced into stationObjects');
A.ok(/stationObjects,\s*\/\/ Class Loadouts/.test(idx), 'stationObjects is threaded into runOnce');
const composeSeg = idx.slice(idx.indexOf('const sRoom = station.rooms'), idx.indexOf('const sRoom = station.rooms') + 2000);
A.ok(/o\.stationObjects[\s\S]{0,120}roomTypes\.concat\(o\.stationObjects\)/.test(composeSeg),
  'skill availability unions the room objects with the STATION-WIDE gear (a desk-only specialist still gets its class skills)');
A.ok(/placedTypes: skillPlacedTypes/.test(composeSeg), 'skillsCatalog.compose gates on the shared-gear placedTypes');
// and TOOL reach is still resolved from the room only (NOT widened by stationObjects) — the guard the task requires.
A.ok(/let resolved = enforceSyntheticOnly\(resolveTools\(agentId, station,/.test(idx)
  && /resolved = enforceRunAuthority\(resolved, registry, userControlAuthority\)/.test(idx),
  'room-scoped tool projection is preserved, then the host removes unauthorized user-control effects');
A.ok(!/resolveTools\([^)]*stationObjects/.test(idx), 'stationObjects is NOT fed into the tool projection (only skills widen to shared gear)');
// 4c. FUNCTIONAL: catalog.compose availability with the shared-gear union — a package skill that requires cabinet
// composes when the STATION has a cabinet even though the agent's own room is desk (compute) only.
{
  const SKlib = [{ slug: 'deskskill', name: 'DeskSkill', description: '', category: 'A', requires: ['cabinet'], default: false, body: 'D' }];
  // agent room desk-only (no cabinet) -> the class package alone can't force the skill in (still availability-gated)
  A.eq(catalog.compose(SKlib, { placedTypes: [], agentSkills: ['deskskill'] }).indexOf('DeskSkill'), -1,
    'a class skill stays gated: no cabinet anywhere -> the recipe is not offered');
  // union the STATION\'s cabinet in (what the sidecar does) -> the desk-only specialist now gets its class skill
  A.ok(catalog.compose(SKlib, { placedTypes: ['cabinet'], agentSkills: ['deskskill'] }).indexOf('DeskSkill') >= 0,
    'once the STATION has the gear, the desk-only specialist\'s class skill composes (the whole point)');
}

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

/* ---------- S3a'. SPECIALIST ARCHIVE: the bay keeps the deep cuts one click away (never gated) ---------- */
A.ok(/function archiveSectionHTML\(/.test(mkt), 'the bay has a SPECIALIST ARCHIVE section');
A.ok(/Specialties\.archetypes/.test(mkt), 'the archive renders from the live archetype pool (never hardcoded)');
A.ok(/archiveOpen = !archiveOpen/.test(mkt), 'the archive header toggles open/closed');
A.ok(/archs\.map\(cardHTML\)/.test(mkt), 'archive classes render as REAL class cards (focusable + summonable)');
A.ok(/archiveSectionHTML\(filtering\)/.test(mkt), 'search/lane filters include the archive — search must FIND a class, never hide one');

/* ---------- S3a. DOSSIER: kit + skill package render from LIVE sources (no hardcoded prop labels) ---------- */
// the kit block resolves each objectType's prop label from the LIVE catalog (PropSprites.CATALOG via
// WorldModel.CAP_PROP_MAP) and its grant from WorldModel's owned CAP_LABEL — never a hardcoded prop name.
A.ok(/function kitBlockHTML\(s\)/.test(mkt), 'the dossier has a DRAWS ON STATION GEAR block');
A.ok(/DRAWS ON STATION GEAR/.test(mkt), 'the dossier labels the gear section "DRAWS ON STATION GEAR" (shared-gear model)');
A.ok(!/STANDARD ISSUE KIT/.test(mkt), 'the dossier no longer calls the gear a per-agent "STANDARD ISSUE KIT"');
A.ok(!/requisitioned at its workstation/.test(mkt), 'the dossier no longer claims the gear is requisitioned at a per-agent workstation');
A.ok(/function kitPropLabel\(objType\)/.test(mkt), 'kit labels resolve through kitPropLabel (from the live catalog)');
const kpl = mkt.slice(mkt.indexOf('function kitPropLabel('), mkt.indexOf('function kitPropLabel(') + 900);
A.ok(/PropSprites\.CATALOG/.test(kpl), 'kitPropLabel reads the LIVE PropSprites catalog for the prop label (never hardcoded)');
A.ok(/CAP_PROP_MAP/.test(kpl), 'kitPropLabel maps the objectType through WorldModel.CAP_PROP_MAP (the owned source)');
A.ok(/WorldModel/.test(mkt) && /CAP_LABEL/.test(mkt), 'the dossier resolves capability grants from WorldModel.CAP_LABEL (the owned power-word source)');
// PRESENT/MISSING: the gear block checks each objectType against the ACTUAL station props (World.stationCaps),
// rendering present gear as available and missing gear as an honest dim "not on station — add in REFIT".
const kbh = mkt.slice(mkt.indexOf('function kitBlockHTML('), mkt.indexOf('function kitBlockHTML(') + 1200);
A.ok(/stationGearSet\(\)/.test(kbh), 'the gear block checks present/missing against the live station');
A.ok(/function stationGearSet\(\)[\s\S]{0,200}World\.stationCaps/.test(mkt), 'stationGearSet reads World.stationCaps (the ACTUAL station props)');
A.ok(/not on station/.test(kbh), 'missing gear renders an honest "not on station" state');
A.ok(/mkt-kit-missing/.test(kbh), 'missing gear is dimmed via the mkt-kit-missing state');
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
  'the gear picker offers the shareable station caps only (computer/connector are per-agent manual-bind, excluded)');
A.ok(/STATION GEAR IT DRAWS ON/.test(mkt), 'the custom builder labels the gear picker "STATION GEAR IT DRAWS ON" (shared-gear, informational)');
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

/* ---------- S3b'. CUSTOM EDIT: the SAME builder edits a custom class, prefilled, and round-trips the loadout ----------
   A custom class is a full loadout, so editing one must expose the SAME three pickers (kit/skills/effort) — not the
   rename-only save form. We source-lock that the EDIT button routes an existing custom into the builder with the
   loadout state prefilled from the saved spec, and functionally prove an edit round-trips a NEW loadout through the
   real Specialties store while keeping the SAME record id (an upsert, not a new class). */
// the EDIT button (only rendered for s.custom) prefills the builder's loadout state from the spec and opens `build`.
const editWireSeg = mkt.slice(mkt.indexOf("const edit = sc.querySelector('.mkt-edit')"), mkt.indexOf("const rEdit = sc.querySelector"));
A.ok(/editingId = edit\.dataset\.id/.test(editWireSeg), 'EDIT records which custom class is being edited (editingId)');
A.ok(/buildKit = \(s && Array\.isArray\(s\.kit\)\) \? s\.kit\.slice\(\) : \[\]/.test(editWireSeg), 'EDIT prefills the kit picker from the saved spec');
A.ok(/buildSkills = \(s && Array\.isArray\(s\.skills\)\) \? s\.skills\.slice\(\) : \[\]/.test(editWireSeg), 'EDIT prefills the skill picker from the saved spec');
A.ok(/buildEffort = \(s && s\.reasoningEffort\) \|\| null/.test(editWireSeg), 'EDIT prefills the effort selector from the saved spec');
A.ok(/view = 'build'/.test(editWireSeg), 'EDIT opens the builder form (with the loadout pickers), not the rename-only save form');
// the builder form is edit-aware: it prefills name/emoji/tagline/purpose/manual from the spec and re-labels the CTA.
const bfhSeg = mkt.slice(mkt.indexOf('function buildFormHTML('), mkt.indexOf('const KIT_PICKABLE'));
A.ok(/const editing = editingId \? Specialties\.get\(editingId\) : null/.test(bfhSeg), 'buildFormHTML resolves the class being edited');
A.ok(/EDIT CUSTOM CLASS/.test(bfhSeg), 'the builder titles itself EDIT CUSTOM CLASS when editing');
A.ok(/SAVE CHANGES/.test(bfhSeg), 'the edit CTA reads SAVE CHANGES (not CREATE CLASS)');
A.ok(/value="' \+ esc\(d\.name \|\| ''\)/.test(bfhSeg) && /value="' \+ esc\(d\.tagline \|\| ''\)/.test(bfhSeg), 'the builder prefills name + tagline from the spec');
A.ok(/esc\(d\.purpose \|\| ''\)/.test(bfhSeg) && /esc\(d\.manual \|\| ''\)/.test(bfhSeg), 'the builder prefills purpose + standing orders from the spec');
// HONESTY: the edit copy states editing does NOT retroactively mutate already-summoned agents (they own their loadout).
A.ok(/already-summoned agents keep the loadout they were given/.test(bfhSeg), 'the edit copy is honest: editing a class does not mutate already-summoned agents');
// the CREATE/SAVE handler upserts by id when editing (same record) and preserves non-authored carried fields.
A.ok(/if \(editing\) spec\.id = editing\.id/.test(createSeg), 'SAVE CHANGES upserts the SAME record id when editing (not a new class)');
A.ok(/Object\.assign\(\{\}, editing \|\| \{\}/.test(createSeg), 'editing starts from the saved record so carried fields (persona/tags/starters) survive');
// FUNCTIONAL round-trip: create a custom, then edit it to a NEW loadout — the store keeps the id and swaps the loadout.
{
  const created = S.saveCustom({ name: 'Edit QA', purpose: 'seed', kit: ['dish'], skills: ['web-research'], reasoningEffort: 'low' });
  const id = created.id;
  // an edit is saveCustom with the SAME id and a new loadout (exactly what the builder's SAVE CHANGES sends).
  const edited = S.saveCustom({ id, name: 'Edit QA', purpose: 'seed', kit: ['cabinet', 'notebook'], skills: ['deep-research'], reasoningEffort: 'high' });
  A.eq(edited.id, id, 'editing keeps the SAME record id (an upsert, not a new class)');
  A.eq(S.customs().filter(c => c.id === id).length, 1, 'editing does not duplicate the class in the store');
  A.ok(edited.kit.indexOf('cabinet') >= 0 && edited.kit.indexOf('notebook') >= 0 && edited.kit.indexOf('dish') < 0, 'the edited kit replaced the original (dish gone, cabinet+notebook in)');
  A.ok(edited.skills.indexOf('deep-research') >= 0 && edited.skills.indexOf('web-research') < 0, 'the edited skill package replaced the original');
  A.eq(edited.reasoningEffort, 'high', 'the edited reasoning effort round-trips');
  // and it survives a reload from the store shape
  const round = S.get(id);
  A.ok(round && round.kit.length === 2 && round.reasoningEffort === 'high' && round.skills[0] === 'deep-research', 'the edited loadout persists on the saved record');
  S.removeCustom(id);
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
