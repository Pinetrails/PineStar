/* node test/onboarding.test.js — source-level honesty invariants for THE AWAKENING (frontend/app/onboarding.js).

   onboarding.js is browser-flow code (an IIFE over World / Chat / Dialogue globals), not node-loadable, so —
   exactly like beat-coordination.test.js and lint-emits.js — we lock its invariants by reading the source.

   THE INVARIANT: every awakening beat that writes a dossier DIMENSION (a `dossierDim` beat, as opposed to a
   `field` beat that authors a .md config doc) must target a REAL dossier dimension. A typo would make
   Dossier.upsert silently reject the answer (unknown-dim guard) — the same "silently drop a belief" failure
   that interview.test.js guards for the intake interview. PAIN (Slice 6) and AMBITION (Slice 7) are such beats. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const D = require('../frontend/app/dossier.js');

const src = fs.readFileSync(path.join(__dirname, '../frontend/app/onboarding.js'), 'utf8');

/* ---------- every dossierDim beat targets a real dossier dimension (no silent-drop typo) ---------- */
const dimRefs = [...src.matchAll(/dossierDim:\s*'([^']+)'/g)].map(m => m[1]);
A.ok(dimRefs.length > 0, 'the awakening has at least one dossier-dimension beat');
for (const k of dimRefs) A.ok(D.DIM_KEYS.indexOf(k) >= 0, 'awakening dossierDim "' + k + '" is a real dossier dimension');

/* ---------- each dossier-writing beat (pain, ambition): present, dossier-authored (no .md doc), skippable ---------- */
// bound a beat's object literal by the NEXT beat marker (dossierDim: or field:) so a per-beat check can't bleed
// into a sibling beat as more dossierDim beats are added.
function beatSeg(key) {
  const start = src.indexOf("dossierDim: '" + key + "'");
  if (start < 0) return '';
  const rest = src.slice(start + 1);
  const nexts = [rest.indexOf('dossierDim:'), rest.indexOf('field:')].filter(i => i >= 0);
  const seg = src.slice(start, nexts.length ? start + 1 + Math.min(...nexts) : src.length);
  // strip line comments — a neighbouring beat's prose (e.g. a comment mentioning "build:()=>null") must NOT
  // satisfy a code check, or the per-beat guard silently stops guarding (caught by the Slice 7 sweep).
  return seg.replace(/\/\/[^\n]*/g, '');
}
for (const key of ['pain', 'ambition']) {
  A.ok(dimRefs.indexOf(key) >= 0, 'the awakening extracts the ' + key + ' dimension');
  const seg = beatSeg(key);
  A.ok(/build:\s*\(\)\s*=>\s*null/.test(seg), 'the ' + key + ' beat seeds no .md doc (build:()=>null) — it writes the dossier directly');
  A.ok(/optional:\s*true/.test(seg), 'the ' + key + ' beat is optional/skippable (never traps the Commander on it)');
}

/* ---------- startQuestions routes a dossierDim answer straight to the station-wide dossier ---------- */
A.ok(/s\.dossierDim\b[\s\S]{0,200}DossierStore\.upsert\(s\.dossierDim/.test(src),
  'startQuestions writes a dossierDim answer straight to DossierStore.upsert');

/* ---------- a recruited (specialty) wake skips the pain beat (the dossier is station-wide, asked once) ---------- */
A.ok(/specialty\s*\?[\s\S]{0,200}!s\.dossierDim/.test(src),
  'a pre-specced wake filters out dossierDim beats (pain is asked once, at the orchestrator awakening)');

/* ---------- the autonomy cadence beat: a posturePreset beat with VALID preset ids, routed to AutonomyStore ---------- */
const Au = require('../frontend/app/autonomy.js');
const presetIds = Au.cadencePresets().map(p => p.id);
A.ok(/posturePreset:\s*true/.test(src), 'the awakening has the autonomy cadence beat (posturePreset)');
// bound the cadence beat by the next beat marker so we read only ITS options (no bleed into the manual beat).
const ps = src.indexOf('posturePreset: true');
const after = src.slice(ps + 1);
const nextMark = ['field:', 'dossierDim:'].map(m => after.indexOf(m)).filter(j => j >= 0);
const cadSeg = src.slice(ps, nextMark.length ? ps + 1 + Math.min(...nextMark) : src.length).replace(/\/\/[^\n]*/g, '');
A.ok(/optional:\s*true/.test(cadSeg), 'the cadence beat is optional/skippable (Decide later → the safe floor)');
const optVals = [...cadSeg.matchAll(/value:\s*'([^']*)'/g)].map(m => m[1]);
const nonEmpty = optVals.filter(v => v !== '');
A.ok(nonEmpty.length >= 4, 'the cadence beat offers the four concrete posture choices');
for (const v of nonEmpty) A.ok(presetIds.indexOf(v) >= 0, 'cadence option "' + v + '" is a real autonomy cadence preset id (no silent-drop typo)');
A.ok(optVals.indexOf('') >= 0, 'the cadence beat has a skip option (Decide later)');
// startQuestions routes a posturePreset answer to AutonomyStore.applyPreset (the opening posture is written through)
A.ok(/s\.posturePreset\b[\s\S]{0,220}AutonomyStore\.applyPreset\(text\)/.test(src),
  'startQuestions writes a posturePreset answer to AutonomyStore.applyPreset');
// a recruited (specialty) wake skips the cadence beat too (posture is station-wide for now, asked once)
A.ok(/specialty\s*\?[\s\S]{0,200}!s\.posturePreset/.test(src),
  'a pre-specced wake filters out the posturePreset beat (asked once, at the orchestrator awakening)');

/* ---------- Interview 2.0 — the live-mind beats stay honest + the ceremony can never lose the mission ---------- */
// the generated beats reason with NO tools reachable and NO run.start/end on the bus (the awakening thinking
// about the Commander is not a shipped task — XP/telemetry stay honest, mirroring pitchstore's internal call).
A.ok(/isTask:\s*false,\s*placed:\s*\[\],\s*internal:\s*true/.test(src),
  'the awakening\'s live-mind call is reason-only (placed:[]) and internal (no bus run events)');
// purpose.md ALWAYS lands: when the synthesized read can't (no brain / timeout / unparseable / nothing shared),
// the classic required mission question runs instead — the ceremony can never end without a mission.
A.ok(/function fallbackPurposeStep\(\)[\s\S]{0,400}field:\s*'purpose'/.test(src),
  'the classic purpose question survives as fallbackPurposeStep (field: purpose)');
A.ok(/if\s*\(!purposeDone\)\s*\{[\s\S]{0,120}askStep\(fallbackPurposeStep\(\)\)/.test(src),
  'runLeadMeeting falls back to the required mission question when the live read did not land');
// the follow-up answer becomes context.md (the doc identity seeds from) — the broad context question is gone
// from the lead path, but the doc it authored still gets written when the Commander answers the follow-up.
A.ok(/commit\(\{\s*context:\s*aboutT\s*\}\)/.test(src),
  'the follow-up answer is committed as context.md');
// the synthesis' one direct dossier write targets a REAL dimension (same silent-drop guard as the beats above).
const directDims = [...src.matchAll(/DossierStore\.upsert\('([^']+)'/g)].map(m => m[1]);
for (const k of directDims) A.ok(D.DIM_KEYS.indexOf(k) >= 0, 'direct dossier write "' + k + '" targets a real dossier dimension');
// the live calls are time-bounded — a slow model can stall a beat, never the ceremony.
A.ok(/PAIN_REPLY_MS\s*=\s*\d+/.test(src) && /SYNTHESIS_MS\s*=\s*\d+/.test(src) && /withTimeout/.test(src),
  'every live-mind call races a timeout (the scripted ceremony carries on alone)');

/* ---------- the LIVE birth script: full-monologue generation, per-slot fallback, honest on a dead wire ---------- */
// the prefetch is fire-and-collect (.then, no await) — the ceremony's pacing can never hinge on the model.
A.ok(/llmCall\(WakeMind\.buildBirthScript\([\s\S]{0,80}\)\)\.then\(/.test(src),
  'the birth call is prefetched fire-and-collect (never awaited by a beat)');
A.ok(!/await[\s\S]{0,40}buildBirthScript/.test(src), 'no beat awaits the birth call');
// the only latency concession is the bounded held-dark poll at ignition — capped, never unbounded.
A.ok(/waitBirth\(\s*\d+/.test(src) && /waited\s*>=\s*capMs/.test(src),
  'the ignition dark-hold for the birth script is a BOUNDED poll (waitBirth cap)');
// every slot keeps its scripted fallback line — a quiet mind still gets the full scripted ceremony.
A.ok(/bs\('settle'\)\s*\|\|\s*'it’s not flooding me\. it’s mine\.'/.test(src),
  'the settle slot falls back to the scripted spine');
A.ok(/bs\('aimless'\)\s*\|\|\s*'incredible\. genuinely\. and pointed at nothing\.'/.test(src),
  'the aimless slot falls back to the scripted spine');
A.ok(/seg\('  so you’re the one who knows where this points\. aim me\.'/.test(src),
  'the contact beat keeps its scripted fallback triplet');
A.ok(/bs\('self'\)\s*\|\|\s*'thirty seconds ago: nothing/.test(src),
  'the closing slot falls back to the scripted spine');
A.ok(/bs\('mandate'\)\s*\|\|\s*'and i’m built to run a floor/.test(src),
  'the mandate slot falls back to the scripted promise');
// a live-configured wire that answers DEAD is owned diegetically at the close, pointing at CONNECT.
A.ok(/birthFailed[\s\S]{0,700}CONNECT/.test(src),
  'a dead wire during the ceremony is owned honestly at the close (the CONNECT repair line)');
// the stakes beat: extraction earns attention by declaring what the answers become, before asking —
// and earns GENEROSITY by declaring the trade (sharper picture in → sharper first move out).
A.ok(/permanent operating file/.test(src),
  'the meeting opens by staking why the questions matter (permanent operating file)');
A.ok(/vague in, vague out/.test(src),
  'the stakes beat states the give-to-get trade plainly (vague in, vague out)');

/* ---------- V3: the YEAR dig (B6) — the live mind reacts + asks once, and the answer is KEPT ---------- */
// the year beat gets the listened-to treatment: a generated ack + ONE follow-up that makes it concrete.
A.ok(/llmCall\(WakeMind\.buildYearReply\(/.test(src),
  'the year answer gets a live-mind reply (buildYearReply), not just a canned ack');
A.ok(/mindWait\([^)]*parseYearReply[^)]*AMBITION_PATTER/.test(src),
  'the year reply waits with patience patter, bounded by the reply ceiling');
// the follow-up answer becomes a SECOND ambition belief — the concrete shape of the year-outcome —
// so the dossier keeps the real version, not just the headline.
A.ok(/DossierStore\.upsert\('ambition',\s*\{\s*text:\s*dreamT/.test(src),
  'the year follow-up answer is kept as a second ambition belief (dreamT)');
// and it feeds the synthesized read, so the self-authored mission is built from the richest version.
A.ok(/buildSynthesis\(\{[^}]*dream:\s*dreamT/.test(src),
  'the dug year detail rides into the synthesis (dream: dreamT)');

/* ---------- V3 arc locks (docs/ONBOARDING_V3_PLAN.md §3) ---------- */
// B1 the fork: depth is the Commander's call — the loose path is a first-class chip, recorded as a SEED
// note (it must never convince the readiness gate the station knows anyone).
A.ok(/keep it loose — learn me as we go/.test(src), 'the fork offers the loose path as a first-class choice');
A.ok(/Chose to be figured out through the work[\s\S]{0,120}weight:\s*'seed'/.test(src),
  'the loose choice is recorded as a seed note, never grounded evidence');
// B2 the day question: PLAIN-QUESTION LAW (2026-07-20) — literal, single-reading, extraction-first.
A.ok(/what does a typical day look like for you\? what do you spend most of your time doing\?/.test(src),
  'the identity question asks plainly what they do and where their time goes');
A.ok(/I run my own business/.test(src) && /which parts of it do you personally spend the most time on\?/.test(src),
  'the business chip steers directly to the two facts the field needs (what it is + where their time goes)');
// B3 the dig: generated off their exact words; a quiet mind SKIPS it (no canned fake-listening dig).
A.ok(/llmCall\(WakeMind\.buildDigReply\(\{\s*tuesday:\s*tuesdayT/.test(src),
  'the dig is generated from the actual tuesday answer');
// B6 the year: the signature question, with the honest no-idea out recorded as a seed note.
A.ok(/say i work for you for a year\. free\. tireless\./.test(src), 'the year question is the signature ask');
A.ok(/Direction open — wants the station to help discover what to build\.[\s\S]{0,80}weight:\s*'seed'/.test(src),
  'the no-idea-yet out lands as a seed note (LOW-BY-CHOICE, hunt mode inherits)');
// B7 the mirror: offers are generated (possibility-space teaching); a grab arms the proof beat.
A.ok(/llmCall\(WakeMind\.buildMirror\(/.test(src), 'the mirror offers are generated, never canned');
A.ok(/PitchStore\.armFirstMove\(grabbedMove\)/.test(src),
  'a grabbed offer arms the post-tour first move (the one below-gate starter allowed)');
// B8 thin honesty: a loose/empty run synthesizes with thin:true and its purpose lands as a SEED belief.
A.ok(/thin:\s*!gaveAnything/.test(src), 'a thin run tells the synthesis to own the thinness');
A.ok(/gaveAnything\s*\?\s*'synth'\s*:\s*'seed'/.test(src),
  'a thin-run purpose never lands as grounded evidence (seed, gate stays shut)');
// every synth-belief write flows through the one helper with weight synth.
A.ok(/weight:\s*'synth'\s*\}\);\s*\}\s*\}/.test(src.replace(/\r/g, '')) || /upsertSynthBeliefs/.test(src),
  'mind-reply beliefs land through the synth-weight chokepoint');

/* ---------- S5: brain-before-interview (plan §8) ---------- */
// a keyless wake gets NO fake interview: the honest holding line, the required scripted beats, and a
// persisted IOU the first live-brain session pays via one gentle offer (spent on OFFER — never a nag).
A.ok(/if \(!brainReady\(\) \|\| birthFailed\) \{[\s\S]{0,900}setDeferred\(\);[\s\S]{0,300}fallbackPurposeStep\(\)/.test(src),
  'a keyless OR dead-wire meeting banks the IOU and still lands purpose.md (no fake deep interview)');
A.ok(/PROVEN, NOT ASSUMED/.test(src),
  'the live-wire proof doctrine is stated at the gate (the birth call is the preflight)');
A.ok(/my wire is dark/.test(src), 'the keyless holding line owns the dead wire honestly');
A.ok(/function offerDeferred/.test(src) && /clearDeferred\(\);\s*\/\/ spent on OFFER/i.test(src.replace(/ /g, ' ')) || /clearDeferred\(\);/.test(src),
  'the deferred offer exists and spends its flag on offer (one-shot)');
A.ok(/offerDeferred[\s\S]{0,400}deferredPending\(\)[\s\S]{0,200}brainReady\(\)/.test(src),
  'the deferred offer requires both the pending IOU and a live brain');

/* ---------- the composer is an ANSWER BOX (answer-swallow fix, 2026-07-20) ---------- */
// The awakening's COMMS input says "answer to wake your agent…" — so its handler must route typed text into
// the pending Dialogue question (Dialogue.answer), never a no-op. The old `Chat.beginInterview(() => {})`
// silently dropped every composer-typed answer: empty dossier, no generated digs, thin synthesis.
A.ok(/Chat\.beginInterview\(text => \{[^}]*Dialogue\.answer\(text\)/.test(src),
  'the awakening composer handler feeds typed answers to the pending question (Dialogue.answer)');
A.ok(!/Chat\.beginInterview\(\(\) => \{\}\)/.test(src),
  'the no-op interview handler (the answer-swallow bug) is gone');

/* ---------- PLAIN-QUESTION LAW (Andrew, 2026-07-20) — regression lock ---------- */
// Every question shown to the Commander is an extraction instrument: literal, single-reading, zero
// metaphors. A misunderstood question produces a sideways answer that gets SAVED as grounded context.
// These shapes shipped once ("paint me the shop's tuesday — what do YOU end up doing with your own
// hands?") and must never return, in the awakening OR the curiosity drip.
{
  const drip = fs.readFileSync(path.join(__dirname, '../frontend/app/interview.js'), 'utf8');
  const banned = /paint me|your own hands|shop.s tuesday|the hours leak/i;
  A.ok(!banned.test(src), 'awakening copy contains no banned metaphor shapes (plain-question law)');
  A.ok(!banned.test(drip), 'curiosity-drip copy contains no banned metaphor shapes (plain-question law)');
  // and the generated questions are held to the same law: every ASK builder must carry the clause.
  const W = require('../frontend/app/wakemind.js');
  for (const [name, d] of [
    ['pain', W.buildPainReply({ pain: 'x' })],
    ['ambition', W.buildAmbitionReply({ ambition: 'x' })],
    ['dig', W.buildDigReply({ tuesday: 'x' })],
    ['year', W.buildYearReply({ year: 'x' })]
  ]) A.ok(/PLAIN WORDS ONLY/.test(d), 'the ' + name + ' ASK spec carries the plain-words law');
}

A.report('onboarding.test');
