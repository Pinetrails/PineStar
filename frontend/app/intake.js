/* STARNET — intake.js : THE INTAKE INTERVIEW flow (Commander Dossier, Phase B slice 1).

   The COMMS half of the active "get to know the Commander" move — a thin controller that mirrors
   onboarding.js's answer loop, but lighter and mid-game: it runs the questions interview.js planned, in
   the agent's own COMMS voice, and folds each answer into the station-wide dossier (DossierStore.upsert)
   through the same Keep/forget glass box the panel uses. Optional + skippable: every question can be
   skipped, partial completion still banks what was answered, and it never calls the model (Chat interview
   mode intercepts input). ALL decision logic lives in the pure interview.js; this is just the COMMS glue. */
'use strict';
const Intake = (() => {
  let questions = [], idx = 0, accepting = false, running = false;
  let onCommit = null, onDone = null;

  const sfx = n => { try { if (typeof SFX === 'object' && SFX[n]) SFX[n](); } catch (_) {} };
  function type(segs, cb) {
    if (typeof Chat !== 'undefined' && Chat.typeLine) return Chat.typeLine(segs, cb);
    if (cb) cb();
    return () => {};
  }

  // start an interview over the dimensions in opts.skip-complement. Returns true if it began, false on a
  // no-op (already running, no Chat, or nothing left to ask). opts: { skip:[knownDims], onCommit(belief),
  // onDone(), onEmpty() }.
  function start(opts) {
    opts = opts || {};
    if (running) return false;
    if (typeof Chat === 'undefined' || !Chat.beginInterview) return false;
    if (typeof Onboarding !== 'undefined' && Onboarding.isRunning && Onboarding.isRunning()) return false;   // never hijack the awakening's COMMS input handler (defense-in-depth; the panel guards too)
    questions = (typeof Interview !== 'undefined') ? Interview.plan({ skip: opts.skip || [] }) : [];
    if (!questions.length) { if (opts.onEmpty) { try { opts.onEmpty(); } catch (_) {} } return false; }
    onCommit = opts.onCommit || null;
    onDone = opts.onDone || null;
    idx = 0; accepting = false; running = true;
    Chat.beginInterview(text => answer(text, text, false), { placeholder: 'tell the station about yourself… (or “skip”)', status: 'getting to know you…' });
    type([{ text: 'one second, Commander — let me actually get to know you. this shapes how every agent here works for you. answer or tap, “skip” anything.', cps: 48, holdAfter: 250 }], () => setTimeout(ask, 450));
    return true;
  }

  function ask() {
    if (!running) return;
    const q = questions[idx];
    if (!q) return finish();
    const myIdx = idx;   // bind this question's index so a stale chip row (left over when the user TYPED a
    const segs = [];     //   prior answer instead of tapping) can never answer a LATER question
    if (q.pre) segs.push({ text: q.pre, cps: 47, holdAfter: 300 });
    segs.push({ text: q.ask, cps: 47 });
    type(segs, () => {
      if (!running) return;
      accepting = true;
      if (q.chips && Chat.choices) Chat.choices(q.chips, item => {
        if (!accepting || idx !== myIdx) return;   // ignore a tap meant for a question we've already moved past
        answer(item.value != null ? item.value : item.label, item.label, !!item.skip);
      });
    });
  }

  // commit = what gets written; display = the echoed Commander line; explicitSkip from a skip chip.
  function answer(commit, display, explicitSkip) {
    if (!accepting || !running) return;
    const q = questions[idx]; if (!q) return;
    const text = (commit == null ? '' : String(commit)).trim();
    const isSkip = explicitSkip || text === '';
    accepting = false;
    if (Chat.echoUser) Chat.echoUser(isSkip ? '(skip)' : (display != null ? String(display) : text));
    if (!isSkip && onCommit && typeof Interview !== 'undefined') {
      const belief = Interview.beliefFromAnswer(q, text);
      if (belief) { try { onCommit(belief); } catch (_) {} sfx('truth'); }   // a soft bell as the station learns one thing about you
    }
    idx++;
    setTimeout(ask, 520);
  }

  function finish() {
    if (!running) return;
    running = false; accepting = false;
    if (Chat.endInterview) Chat.endInterview();
    type([{ text: 'got it. i know you a little better now — and so does every agent on the station. you can refine any of it in the COMMANDER dossier whenever.', cps: 48 }], () => {});
    if (onDone) { try { onDone(); } catch (_) {} }
  }

  // teardown if the interview is abandoned (e.g. DISCONNECT mid-interview) — never leave COMMS stuck in
  // interview mode.
  function stop() {
    if (!running) return;
    running = false; accepting = false;
    if (typeof Chat !== 'undefined' && Chat.endInterview) Chat.endInterview();
  }
  function isRunning() { return running; }

  return { start, stop, isRunning };
})();
