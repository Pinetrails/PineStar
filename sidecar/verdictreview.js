/* sidecar/verdictreview.js — VERDICT-TRIGGERED SKILL REVIEW (consistency loop, slice 1, 2026-08-22).

   The background skill review (skillreview.js) fires on run SIZE — ≥4 tool calls, ≥8 turns, ≥5000 chars. The
   Commander's own verdict on the work was never an input: a small run rated `miss` taught the skillbase nothing,
   which is exactly the consistency complaint ("it did it wrong, and next week it does it wrong again").

   This module is the pure half of the fix. At run end, a run that did NOT earn a size-review gets a compact
   REVIEW PACKET parked here (the transcript + the aux provider handles the review would need). When a verdict
   arrives on POST /api/growth/ratings and it is `ok` or `miss`, the packet is TAKEN (once) and index.js runs the
   same quiet review loop with the verdict in the prompt. `great` never triggers — praise is not a lesson.

   Bounded by construction: a capped LRU (oldest evicted), a TTL so a stale packet never reviews a run the
   Commander rated a day later against a skillbase that has since moved, and take() deletes. Pure + clock-injected
   (node-testable); index.js owns the provider objects and the loop. */
'use strict';

const VERDICTS_THAT_TEACH = new Set(['ok', 'miss']);

function makeVerdictReview(opts) {
  opts = opts || {};
  const cap = Number.isFinite(opts.cap) && opts.cap > 0 ? Math.floor(opts.cap) : 40;
  const ttlMs = Number.isFinite(opts.ttlMs) && opts.ttlMs > 0 ? opts.ttlMs : 6 * 60 * 60 * 1000;
  const now = typeof opts.now === 'function' ? opts.now : () => 0;   // clock is INJECTED (repo determinism law); index.js passes the real one
  const packets = new Map();   // runId -> { at, packet }  (Map keeps insertion order = LRU by arrival)

  function sweep() {
    const t = now();
    for (const [id, row] of packets) if (t - row.at > ttlMs) packets.delete(id);
    while (packets.size > cap) packets.delete(packets.keys().next().value);
  }

  // park a run's review packet. Only runs that were NOT already reviewed belong here (the caller decides);
  // a second stash for the same runId replaces the first (latest state wins).
  function stash(runId, packet) {
    const id = String(runId || '').trim();
    if (!id || !packet || typeof packet !== 'object') return false;
    packets.delete(id);
    packets.set(id, { at: now(), packet });
    sweep();
    return true;
  }

  // does this verdict earn a review? praise never does; only a real run (reason done) with a packet on file.
  function shouldTrigger(runId, verdict) {
    const id = String(runId || '').trim();
    if (!id || !VERDICTS_THAT_TEACH.has(String(verdict || ''))) return false;
    sweep();
    return packets.has(id);
  }

  // take the packet (once). Returns null when there is none or the verdict does not teach.
  function take(runId, verdict) {
    if (!shouldTrigger(runId, verdict)) return null;
    const id = String(runId).trim();
    const row = packets.get(id);
    packets.delete(id);
    return row ? row.packet : null;
  }

  function size() { sweep(); return packets.size; }
  function has(runId) { sweep(); return packets.has(String(runId || '').trim()); }

  return { stash, shouldTrigger, take, size, has, cap, ttlMs };
}

module.exports = { makeVerdictReview, VERDICTS_THAT_TEACH };
