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
     (additive use of the frozen contract — kind:'chain'). */
'use strict';

const MAX_HOPS = 6;            // stages AFTER the first (a drawn floor with more is a design smell, not a run)
const MAX_CHAIN_USD = 2.00;    // the whole chain's spend ceiling — one message must not become an open tab
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

  /* The handoff turn. A downstream stage is NOT the user — it is a machine being handed material — so the turn
     names the line explicitly. Carrying the ORIGINAL request as well as the upstream output is load-bearing:
     a writer handed only research has no idea what was asked, and would invent one. */
  function handoffText(originalText, fromAgentId, upstream, hop) {
    return 'PIPELINE HANDOFF — you are stage ' + (hop + 1) + ' of a work line on this station.\n\n'
      + 'The original request was:\n' + String(originalText || '(none recorded)') + '\n\n'
      + 'The upstream stage (' + fromAgentId + ') produced:\n' + String(upstream) + '\n\n'
      + 'Do YOUR part of this work and produce the output for the next stage. Do not restate the upstream '
      + 'output — build on it. Answer with the work itself, not a description of what you would do.';
  }

  const preview = s => String(s || '').replace(/\s+/g, ' ').slice(0, PREVIEW);

  /* advance({ agentId, text, originalText, signal, runAgent }) — run every downstream stage of the line that
     starts at the dock which just finished. `runAgent` may be supplied PER CALL: the runner is built once in
     index.js with the floor's edge function bound, and each caller (the channel hub, a cron fire, the dev
     route) hands in its own way to execute a hop — the hub keeps owning transcripts/persona/consent and stays
     require-free, exactly like the runOnce it is already handed. Returns:
       { text, agentId, hops:[{agentId,usd,ms}], usd, stopped } — `text` is what the caller should DELIVER,
       `agentId` who produced it, `stopped` a short honest reason when the line did not run to its end (null
       when it did). Never throws: a chain is an enhancement to a reply the caller already holds. */
  async function advance(seed) {
    const s = seed || {};
    const startAgent = s.agentId, originalText = s.originalText != null ? s.originalText : s.text;
    const runAgent = typeof s.runAgent === 'function' ? s.runAgent : defaultRunAgent;
    const out = { text: s.text, agentId: startAgent, hops: [], usd: 0, stopped: null };
    if (!nextAgent || !runAgent || !startAgent) return out;

    const visited = { [startAgent]: true };
    let cur = startAgent;
    for (let hop = 1; hop <= maxHops + 1; hop++) {
      if (s.signal && s.signal.aborted) { out.stopped = 'stopped'; return out; }
      // the tag is derived from the OUTPUT of the stage that just ran — this is what makes a FILTER downstream
      // of a dock a real branch on the result rather than a re-read of the original message.
      let target = null;
      try { target = nextAgent(cur, { tag: getTag(out.text) }); } catch (_) { target = null; }
      if (!target) return out;                                   // terminal stage: its reply IS the answer
      if (visited[target]) { out.stopped = 'the line loops back to ' + target; return out; }
      if (hop > maxHops) { out.stopped = 'the line is longer than ' + maxHops + ' stages'; return out; }
      if (out.usd >= maxUsd) { out.stopped = 'the line reached its $' + maxUsd.toFixed(2) + ' limit'; return out; }
      // a stage that produced nothing has nothing to hand on — handing it an empty crate would buy a run that
      // can only hallucinate its input (and the floor would draw a crate carrying nothing).
      if (!String(out.text || '').trim()) { out.stopped = cur + ' produced no output to hand on'; return out; }

      visited[target] = true;
      const workitemId = newId(), t0 = now();
      say('workitem.placed', { workitemId, queueId: target, agentId: target, kind: 'chain', preview: preview(out.text), ts: t0 });

      let r = null;
      try { r = await runAgent({ agentId: target, text: handoffText(originalText, cur, out.text, hop), hop, from: cur, signal: s.signal, workitemId }); }
      catch (e) { r = { error: (e && e.message) || String(e || 'stage failed') }; }
      r = r || {};
      const usd = (typeof r.usd === 'number' && isFinite(r.usd) && r.usd > 0) ? r.usd : 0;
      out.usd += usd;

      // A FAILED STAGE KEEPS THE LAST GOOD ANSWER. The reply the user gets is still real work by a real agent;
      // the note says the line stopped short, so the floor and the channel tell the same story.
      if (r.error || !String(r.text || '').trim()) {
        say('workitem.superseded', { workitemId, agentId: target, ts: now() });
        out.stopped = target + (r.error ? ' failed: ' + r.error : ' returned nothing');
        return out;
      }
      say('workitem.delivered', { workitemId, finalQueueId: target, agentId: target, box: '', ms: now() - t0, ts: now() });
      out.hops.push({ agentId: target, usd, ms: now() - t0 });
      out.text = r.text; out.agentId = target;
      cur = target;
    }
    return out;
  }

  // the honest one-liner appended to a reply whose line stopped short (the caller decides whether to show it).
  function stopNote(res) {
    if (!res || !res.stopped) return '';
    return '\n\n⚠ the work line stopped early — ' + res.stopped + '.';
  }

  return { advance, stopNote, _limits: { maxHops, maxUsd } };
}

module.exports = { makeChainRunner, MAX_HOPS, MAX_CHAIN_USD };
