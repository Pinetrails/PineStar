/* sidecar/routing/chain.js — the AGENTIC GRAPH executor: run the pipeline the Commander DREW.

   The router answers "which agent runs this message?" (one dock). This answers the other half: "and then
   what?" — a dock's output is the next dock's input, hop by hop along the belts, until the line ships out.
   A floor drawn INTAKE -> researcher -> writer -> OUTBOX now runs BOTH agents, and the reply that leaves the
   station is the writer's. Before this, everything downstream of the first dock was scenery.

   PURE ORCHESTRATION — it owns policy and telemetry, never provider/loop internals. Two injected seams:
     nextAgent(agentId, { tag })              -> the downstream agentId, or null (terminal stage)
     runAgent({ agentId, text, hop, from, signal }) -> { text, usd?, error? }
   so it tests headlessly with a fake harness and the hub keeps owning transcripts/consent/media.

   LAWS (each one is a bug this file exists to not have):
   • A CHAIN NEVER GATES THE REPLY. Any stop — hop cap, spend cap, a failed stage, an empty stage, E-STOP —
     delivers the LAST GOOD output with an honest note saying where the line stopped. The belt is never a gate
     (the same law that says work runs with no belts laid); a broken stage 3 must not swallow stage 2's answer.
   • ONE CRATE, ONE RUN. nextAgent returns a single downstream agent, never a fan-out — K crates in, K crates
     out, or the floor is lying about what it charged you for.
   • NEVER RUN AN AGENT TWICE IN ONE CHAIN. CHAIN_CYCLE refuses looping floors at compile time, but the plan can
     be re-posted MID-CHAIN; the visited set is what makes an infinite paid loop impossible rather than unlikely.
   • EVERY HOP IS A CRATE. workitem.placed/delivered per hop, so the floor shows the handoff it is really doing
     (additive use of the frozen contract — kind:'chain').
   • WORK BELONGS TO A LINE (2026-08-07, Andrew's ruling). The seed carries the `lineId` the work ENTERED on
     (its line's own trigger: the INBOX it arrived at, the routine that fired, the sample dispatched for it).
     It rides into every nextAgent() call, where Pipeline.chainNext refuses to advance a dock whose line the
     run does not belong to. A seed with no lineId — a direct order — advances nothing and spends nothing.
     This module holds no policy of its own here: it TRANSPORTS the origin, the compiled plan decides. */
'use strict';
const Pipeline = require('../../frontend/app/pipeline.js');

const MAX_HOPS = 6;            // stages AFTER the first (a drawn floor with more is a design smell, not a run)
const MAX_CHAIN_USD = 2.00;    // the WHOLE chain's spend ceiling, entry run included (seed.entryUsd) — one message must not become an open tab
const PREVIEW = 40;

function makeChainRunner(o) {
  o = o || {};
  const nextAgent = typeof o.nextAgent === 'function' ? o.nextAgent : null;
  const defaultRunAgent = typeof o.runAgent === 'function' ? o.runAgent : null;
  const emit = typeof o.emit === 'function' ? o.emit : function () {};
  const getTag = typeof o.getTag === 'function' ? o.getTag : function () { return undefined; };
  // the clock is INJECTED (sidecar determinism law — this module holds no wall-clock of its own). Uninjected it
  // reports 0ms hops rather than inventing a time: honest, and the tests run on a fake clock.
  const now = typeof o.now === 'function' ? o.now : function () { return 0; };
  const maxHops = (typeof o.maxHops === 'number' && o.maxHops >= 0) ? o.maxHops : MAX_HOPS;
  const maxUsd = (typeof o.maxUsd === 'number' && o.maxUsd > 0) ? o.maxUsd : MAX_CHAIN_USD;
  let seq = 0;
  const newId = typeof o.newId === 'function' ? o.newId : function () { return 'chain' + (++seq); };
  const say = (n, p) => { try { emit(n, p); } catch (_) {} };

  // The handoff turn is composed by the SHARED pure module (frontend/app/pipeline.js) that also compiles the
  // plan — the browser's COMMS work line loads the same function, so the same floor cannot produce a different
  // run on a different surface. Injectable only so a test can watch what a stage was handed.
  const handoffText = typeof o.handoffPrompt === 'function' ? o.handoffPrompt : Pipeline.handoffPrompt;
  // stageBrief(agentId) -> the RECEIVING dock's standing job brief, or null (step editor, 2026-08-05).
  // Injected like nextAgent — the runner never reads the plan itself. Prompt text only: it rides into the
  // handoff turn below and can never change which agent runs (nextAgent alone decides that).
  const stageBrief = typeof o.stageBrief === 'function' ? o.stageBrief : null;

  /* lineOfAgent(agentId) -> the lineId of the line this dock crews, or null. OPTIONAL, injected exactly
     like nextAgent (router.lineOfAgent is the production implementation; the runner never reads the plan).

     WHY IT EXISTS (2026-08-07 conveyor audit). nextAgent() answers null for two completely different
     situations and this module could not tell them apart:
       (a) THIS DOCK IS THE END OF ITS LINE — its reply IS the answer. Correct, silent, the common case.
       (b) THE LINE REFUSED THE WORK — Pipeline.chainNext's gate found the run carrying a lineId that is
           not this dock's line (a stale id: the floor was edited mid-run and the line re-keyed; or work
           that entered somewhere else entirely). The line does not run and nothing downstream spends.
     Both returned `{ stopped: null }` — i.e. "the line ran to its end", which in case (b) is a lie, and
     this file's FIRST law says every stop delivers an honest note saying where the line stopped. A
     silently-truncated work line is the single hardest thing to diagnose from the outside: the Commander
     drew four stages, paid for one, and every surface told them it finished.

     CONSERVATIVE BY CONSTRUCTION — it may only turn a KNOWN refusal into a note:
       • not injected, or it throws          -> no note (we cannot prove a refusal; never invent one)
       • the dock crews no line on the plan  -> no note (terminal — same degradation Pipeline documents
                                                for plans compiled before line identity existed)
       • the run's line IS this dock's line  -> no note (the gate passed; null means genuinely terminal)
       • the two lines DISAGREE              -> the note. Proven: the gate is the only thing that could
                                                have stopped it.
     A DIRECT ORDER (no lineId at all) stays silent on purpose: "a job you hand this agent yourself is
     answered right here and stops here" is the designed contract (Andrew's ruling, 2026-08-07) and the
     step editor says so on the floor — it is not a line that failed to run. */
  const lineOfAgent = typeof o.lineOfAgent === 'function' ? o.lineOfAgent : null;
  function refusalNote(dock, lineId) {
    if (!lineOfAgent || !lineId) return null;
    let own = null;
    try { own = lineOfAgent(dock); } catch (_) { return null; }
    if (!own || String(own) === String(lineId)) return null;
    // plain language, no ids, no belt vocabulary — the same voice the floor speaks (build.js step card)
    return 'this job did not come in through this line’s door, so the line did not run past ' + dock;
  }

  /* JOINER + LOOP seams (2026-08-21) — all optional, all injected like nextAgent:
       stepAgent(agentId, ctx) -> Pipeline.chainStep's answer (router.chainStep in production). When absent the
                                  runner behaves byte-for-byte as before (nextAgent only: no barriers, no loops).
       fanSiblings(agentId)     -> the other first docks of a fan-out split feeding this dock (router.fanSiblings).
       tileOf(junctionKey)      -> { x, y } (the key IS "x,y" — parsed here, injectable for tests).
       setTimer(fn, ms)         -> the joiner timeout clock (default setTimeout; tests inject a fake).
       barrierStore             -> { load() -> obj, save(obj) } — see RESTART below. */
  const stepAgent = typeof o.stepAgent === 'function' ? o.stepAgent : null;
  const fanSiblings = typeof o.fanSiblings === 'function' ? o.fanSiblings : null;
  const tileOf = typeof o.tileOf === 'function' ? o.tileOf : function (k) { const p = String(k).split(','); return { x: +p[0], y: +p[1] }; };
  const setTimer = typeof o.setTimer === 'function' ? o.setTimer : function (fn, ms) { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; };
  const barrierStore = (o.barrierStore && typeof o.barrierStore.load === 'function' && typeof o.barrierStore.save === 'function') ? o.barrierStore : null;

  /* THE JOIN BARRIER — in-memory, keyed "joinTile|runId". A branch DELIVERS its output; the barrier releases
     when `expect` deliveries are in, or when a waiter's timeout (the joiner's timeoutMin) fires with fewer —
     then the merged crate is MARKED partial (Pipeline.joinPayload) so the next stage knows.

     RESTART IS FAIL-LOUD, NOT DURABLE — decided, not defaulted: the continuation of a parked line is a live
     closure inside advance() (the hub's reply path, the cron driver's ledger), and nothing about an in-flight
     chain is persisted anywhere today (the plan is; runs are not). A "durable" barrier that survived a restart
     would release into nobody. So the parked records alone are written through `barrierStore` (beside
     routing.plan.json in production), and at the next boot every leftover is reported — a console line plus
     a workitem.superseded per parked branch, so the floor drops the crate it was drawing — and cleared. */
  const barriers = new Map();
  function persistBarriers() {
    if (!barrierStore) return;
    const snap = {};
    for (const [k, b] of barriers) snap[k] = { expect: b.expect, parts: b.parts.map(p => ({ agentId: p.agentId, workitemId: p.workitemId })), ts: b.ts };
    try { barrierStore.save(snap); } catch (_) {}
  }
  const barrier = {
    deliver(k, expect, agentId, text, timeoutMin) {
      let b = barriers.get(k);
      if (!b) { b = { expect: expect || 0, parts: [], waiters: [], ts: now(), timeoutMin: timeoutMin || 10 }; barriers.set(k, b); }
      b.parts.push({ agentId, text, workitemId: newId() });
      if (b.parts.length >= b.expect) {
        barriers.delete(k); persistBarriers();
        const res = { released: true, parts: b.parts, missing: [] };
        for (const w of b.waiters.splice(0)) w(res);
        return res;
      }
      persistBarriers();
      return { released: false, parts: b.parts, missing: [] };
    },
    wait(k, timeoutMin) {
      const b = barriers.get(k);
      if (!b) return Promise.resolve(null);
      return new Promise(resolve => {
        let done = false;
        const fin = res => { if (done) return; done = true; resolve(res); };
        b.waiters.push(fin);
        setTimer(() => {
          if (done || !barriers.has(k)) return;
          barriers.delete(k); persistBarriers();
          const missing = []; for (let i = b.parts.length; i < b.expect; i++) missing.push('lane ' + (i + 1));
          fin({ released: true, parts: b.parts, missing, timedOut: true });
        }, Math.max(1, (timeoutMin || b.timeoutMin || 10)) * 60 * 1000);
      });
    },
    size() { return barriers.size; }
  };
  // boot: a barrier left on disk is a line that died mid-join — say so, drop its crates, start clean
  if (barrierStore) {
    let left = null; try { left = barrierStore.load(); } catch (_) { left = null; }
    const keys = left && typeof left === 'object' ? Object.keys(left) : [];
    for (const k of keys) {
      const b = left[k] || {};
      try { console.warn('[chain] join barrier lost on restart: ' + k + ' (' + ((b.parts || []).length) + '/' + (b.expect || '?') + ' branches had delivered) — the line will not resume'); } catch (_) {}
      for (const p of (b.parts || [])) if (p && p.workitemId) say('workitem.superseded', { workitemId: p.workitemId, agentId: p.agentId || '', ts: now() });
    }
    if (keys.length) { try { barrierStore.save({}); } catch (_) {} }
  }

  const preview = s => String(s || '').replace(/\s+/g, ' ').slice(0, PREVIEW);

  /* advance({ agentId, text, originalText, signal, runAgent, entryUsd }) — run every downstream stage of the
     line that starts at the dock which just finished. `runAgent` may be supplied PER CALL: the runner is built once in
     index.js with the floor's edge function bound, and each caller (the channel hub, a cron fire, the dev
     route) hands in its own way to execute a hop — the hub keeps owning transcripts/persona/consent and stays
     require-free, exactly like the runOnce it is already handed. Returns:
       { text, agentId, hops:[{agentId,usd,ms}], usd, stopped } — `text` is what the caller should DELIVER,
       `agentId` who produced it, `stopped` a short honest reason when the line did not run to its end (null
       when it did). Never throws: a chain is an enhancement to a reply the caller already holds. */
  async function advance(seed) {
    const s = seed || {};
    const startAgent = s.agentId, originalText = s.originalText != null ? s.originalText : s.text;
    // the line this work ENTERED on (null for a direct order — the gate then keeps every dock terminal)
    const lineId = (s.lineId != null && String(s.lineId)) || null;
    const runAgent = typeof s.runAgent === 'function' ? s.runAgent : defaultRunAgent;
    /* the ENTRY run's reconciled spend (2026-08-10 audit): maxUsd bounds the WHOLE chain and stage one is part
       of the chain — seeded by the caller because this module never sees that run. `out.usd` stays HOP-ONLY:
       both production callers ADD it to their own entry accounting (cron-driver `state.usd += line.usd`, the
       hub's onLineOutcome), so totalling the entry into it here would double-count the same dollars. */
    const entryUsd = (typeof s.entryUsd === 'number' && isFinite(s.entryUsd) && s.entryUsd > 0) ? s.entryUsd : 0;
    const out = { text: s.text, agentId: startAgent, hops: [], usd: 0, stopped: null };
    if (!nextAgent || !runAgent || !startAgent) return out;

    const visited = { [startAgent]: true };
    let spent = entryUsd;   // entry + hops — what the $ ceiling is actually measured against
    let cur = startAgent;
    /* JOIN + LOOP state (2026-08-21) — per advance() call, never across calls:
       runId    keys the joiner barrier: one barrier per (joiner tile, run) — branches of the SAME run rejoin,
                two different messages never get glued together.
       iter     loopKey -> how many times this run has been sent back round that gate.
       pending  fan-out branches still to run: [{ agentId, text, from }] — branches run SEQUENTIALLY (one
                sidecar, one loop; parallel runs would double the RAM and the floor draws one crate at a time).
       fromTile resume a walk from a junction the previous hop released (a joiner exit / a loop gate lane). */
    const runId = (s.runId != null && String(s.runId)) || (s.workitemId != null && String(s.workitemId)) || newId();
    const iter = {}, pending = [];
    let fromTile = null, via = null, loopHops = 0;
    // inside a loop pass every hop is a re-visit by design (the body runs again); `looping` is raised at a
    // re-entry and lowered when the gate lets the crate out on its done lane
    let looping = false;
    // while a queued fan-out branch is running, the line's LAST GOOD answer is still the entry's own output
    const entryOut = { text: s.text, agentId: startAgent }; let branchMode = false;
    /* ENTRY FAN-OUT: resolveTarget named ONE dock for the inbound message and it has already run (`cur`). If
       that dock sits on a lane of a split that feeds a JOINER, the other lanes are parallel branches the drawn
       line promised; queue them from the ORIGINAL text so the barrier can fill. The entry's own output goes
       first, the siblings follow — deterministic, sorted by fanSiblings. */
    if (fanSiblings && lineId) {
      let sib = []; try { sib = fanSiblings(cur, { lineId }) || []; } catch (_) { sib = []; }
      for (const a of sib) pending.push({ agentId: a, text: originalText, from: null, entry: true });
    }
    // a branch that ends (terminal / parked at the joiner) hands the loop to the next queued branch
    const nextPending = () => { const b = pending.shift(); if (!b) return false; cur = b.from || cur; out.text = b.text; branchMode = true; return b; };
    let forced = null;   // a queued branch's agent, run on this hop in place of the walk's answer
    for (let hop = 1; hop <= 400; hop++) {
      if (s.signal && s.signal.aborted) { out.stopped = 'stopped'; return out; }
      // the tag is derived from the OUTPUT of the stage that just ran — this is what makes a FILTER downstream
      // of a dock a real branch on the result rather than a re-read of the original message.
      let target = null, step = null, loopHop = false, entryBranch = false;
      if (forced) {
        target = forced.agentId; entryBranch = !!forced.entry; forced = null;
      } else {
        const ctx = { tag: getTag(out.text), lineId: lineId, fromTile: fromTile, via: via };
        fromTile = null; via = null;
        try { step = stepAgent ? stepAgent(cur, ctx) : null; } catch (_) { step = null; }
        if (step && step.branches) {
          // a FAN-OUT split mid-line: every lane runs from this output; first lane now, the rest queued
          const br = step.branches.slice();
          target = br.shift() || null;
          for (const a of br) pending.push({ agentId: a, text: out.text, from: cur });
        } else if (step && step.join) {
          // THE BARRIER. Park this branch's output; release only when every in-lane has delivered for this run.
          const r = barrier.deliver(step.join + '|' + runId, step.expect, cur, out.text, step.timeoutMin);
          if (!r.released) {
            if (pending.length) { forced = nextPending(); hop--; continue; }   // run the next branch; it may fill the barrier
            // nothing left to run in THIS call: wait for another deliverer (same run) or the joiner's timeout
            const w = await barrier.wait(step.join + '|' + runId, step.timeoutMin);
            if (!w) { out.stopped = 'the joiner at ' + step.join + ' lost its branches'; return out; }
            out.text = Pipeline.joinPayload(w.parts, w.missing);
            say('workitem.delivered', { workitemId: newId(), finalQueueId: cur, agentId: cur, box: 'join:' + step.join, ms: 0, ts: now() });
          } else {
            out.text = Pipeline.joinPayload(r.parts, []);
          }
          branchMode = false;
          // the merged crate continues from the joiner's exit; the last deliverer is its producer
          fromTile = tileOf(step.join);
          if (!step.next) { out.stopped = null; return out; }   // the joiner ships straight out: merged text IS the answer
          hop--; continue;
        } else if (step && step.loop) {
          const n = iter[step.loop] || 0;
          const again = step.backTo && n < step.max && (!step.when || ctx.tag === step.when);
          if (again) {
            iter[step.loop] = n + 1; loopHop = true; looping = true;
            target = step.backTo; fromTile = null;
            out.text = '[LOOP — pass ' + (n + 1) + ' of ' + step.max + ' round the gate at ' + step.loop + ']\n' + out.text;
          } else {
            target = step.next; looping = false;   // spent (or the verdict passed): leave on the done lane
          }
        } else if (step && step.agentId) {
          target = step.agentId;
        } else if (!stepAgent) {
          try { target = nextAgent(cur, ctx); } catch (_) { target = null; }
        }
      }
      // no target = EITHER a terminal stage (its reply IS the answer — silent, correct) OR the line gate
      // refusing this work. refusalNote tells the two apart, and only speaks when it can prove the second.
      if (!target) {
        if (pending.length) { forced = nextPending(); hop--; continue; }
        out.stopped = refusalNote(cur, lineId); return out;
      }
      if (looping) loopHop = true;
      if (visited[target] && !loopHop) { out.stopped = 'the line loops back to ' + target; return out; }
      if (loopHop) loopHops++;
      if (hop - loopHops > maxHops) { out.stopped = 'the line is longer than ' + maxHops + ' stages'; return out; }
      // PRE-hop because a hop's cost is unknowable before it runs: the ceiling is enforced to within one
      // hop's spend. `spent` (never out.usd) is the guard — entry seeded, so stage one no longer rides free.
      if (spent >= maxUsd) { out.stopped = 'the line reached its $' + maxUsd.toFixed(2) + ' limit'; return out; }
      // a stage that produced nothing has nothing to hand on — handing it an empty crate would buy a run that
      // can only hallucinate its input (and the floor would draw a crate carrying nothing).
      if (!String(out.text || '').trim()) { out.stopped = cur + ' produced no output to hand on'; return out; }

      if (!loopHop) visited[target] = true;
      const workitemId = newId(), t0 = now();
      // `from` = the PRODUCER dock (additive, 2026-08-04): the frontend used to GUESS the upstream dock
      // (alphabetically-first dock whose chain reaches the target) and drew handoff crates leaving the wrong
      // bay on any floor where two lines feed one dock. obj() stanzas carry no additionalProperties:false,
      // so the extra field validates against the frozen workitem.placed contract; old consumers ignore it.
      // `lineId` rides the crate too (additive, same obj() latitude as `from`): the floor reads it to tell a
      // line-owned handoff from an ad-hoc run's own product, so the pipeline never animates a workflow that
      // did not run — and never hides one that did.
      say('workitem.placed', { workitemId, queueId: target, agentId: target, kind: 'chain', from: entryBranch ? undefined : cur, lineId: lineId || undefined, preview: preview(out.text), ts: t0 });

      let r = null;
      // the RECEIVING dock's standing brief rides the handoff turn (null-safe: no seam / no brief = the
      // exact pre-brief prompt, byte for byte — Pipeline.handoffPrompt only appends when one is present).
      let brief = null;
      if (stageBrief) { try { brief = stageBrief(target); } catch (_) { brief = null; } }
      // an ENTRY branch is stage one of its own lane: it gets the original message, not a handoff turn
      const turn = entryBranch ? String(originalText || '') : handoffText(originalText, cur, out.text, hop, brief);
      try { r = await runAgent({ agentId: target, text: turn, hop, from: entryBranch ? null : cur, signal: s.signal, workitemId }); }
      catch (e) { r = { error: (e && e.message) || String(e || 'stage failed') }; }
      r = r || {};
      const usd = (typeof r.usd === 'number' && isFinite(r.usd) && r.usd > 0) ? r.usd : 0;
      out.usd += usd; spent += usd;

      // A FAILED STAGE KEEPS THE LAST GOOD ANSWER. The reply the user gets is still real work by a real agent;
      // the note says the line stopped short, so the floor and the channel tell the same story.
      if (r.error || !String(r.text || '').trim()) {
        say('workitem.superseded', { workitemId, agentId: target, ts: now() });
        out.stopped = target + (r.error ? ' failed: ' + r.error : ' returned nothing');
        if (branchMode) { out.text = entryOut.text; out.agentId = entryOut.agentId; }   // a dead branch never replaces the entry's answer
        return out;
      }
      say('workitem.delivered', { workitemId, finalQueueId: target, agentId: target, box: '', ms: now() - t0, ts: now() });
      out.hops.push({ agentId: target, usd, ms: now() - t0 });
      out.text = r.text; out.agentId = target;
      cur = target;
    }
    out.stopped = 'the line ran past its hop ceiling';
    return out;
  }

  // the honest one-liner appended to a reply whose line stopped short (the caller decides whether to show it).
  function stopNote(res) {
    if (!res || !res.stopped) return '';
    return '\n\n⚠ the work line stopped early — ' + res.stopped + '.';
  }

  return { advance, stopNote, _limits: { maxHops, maxUsd }, _barrier: barrier };
}

module.exports = { makeChainRunner, MAX_HOPS, MAX_CHAIN_USD };
