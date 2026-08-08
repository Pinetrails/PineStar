/* STARNET — journeystore.js: last-good frontend citizen for /api/journey.
   The sidecar owns every claim. This store polls, performs explicit Commander writes, and projects the proven
   evolution stage into the world; it never mints XP and never emits on the frozen U.bus contract. */
'use strict';
const JourneyStore = (() => {
  const POLL_MS = 4000;
  let cache = null, inflight = false, lastFetch = 0, seeded = false, lastStage = 0;

  function apply(journey) {
    if (!journey || typeof journey !== 'object') return false;
    const prior = lastStage;
    cache = journey; lastFetch = Date.now();
    lastStage = Math.max(0, Number(journey.evolution && journey.evolution.stage) | 0);
    try { document.body.dataset.journeyStage = String(lastStage); } catch (_) {}
    if (seeded && lastStage > prior) {
      const name = String((journey.evolution && journey.evolution.name) || 'VECTOR');
      try { if (typeof SFX === 'object' && SFX.milestone) SFX.milestone(); } catch (_) {}
      try { if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify('◆ station vector evolved — ' + name, 'gold'); } catch (_) {}
    }
    seeded = true;
    try { if (typeof StationUI !== 'undefined' && StationUI.rerender) StationUI.rerender('quests'); } catch (_) {}
    return true;
  }

  async function refetch(force) {
    if (inflight || (!force && Date.now() - lastFetch < POLL_MS)) return cache;
    inflight = true;
    try {
      const res = await fetch('/api/journey', { cache: 'no-store' });
      const j = res.ok ? await res.json().catch(() => null) : null;
      if (j && j.ok && j.journey) apply(j.journey);
    } catch (_) { /* last-good cache stays visible */ }
    finally { inflight = false; }
    return cache;
  }

  async function post(body) {
    try {
      const res = await fetch('/api/journey', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
      const j = await res.json().catch(() => null);
      if (j && j.journey) apply(j.journey);
      return j || { ok: false, error: 'journey response unavailable' };
    } catch (_) { return { ok: false, error: 'journey service unavailable' }; }
  }

  function init() { cache = null; inflight = false; lastFetch = 0; seeded = false; lastStage = 0; refetch(true); }
  function sync() { return refetch(false); }
  function status() { return cache; }
  function createMetric(d) { return post(Object.assign({ op: 'metric.create' }, d || {})); }
  function updateMetric(id, current, note) { return post({ op: 'metric.update', id: String(id || ''), current: Number(current), note: String(note || '') }); }
  function retireMetric(id) { return post({ op: 'metric.retire', id: String(id || '') }); }
  function suppress(agentId, domain) { return post({ op: 'adaptation.suppress', agentId, domain }); }
  function resume(agentId, domain) { return post({ op: 'adaptation.resume', agentId, domain }); }
  function reset() { cache = null; seeded = false; lastStage = 0; return post({ op: 'journey.reset' }); }
  function noteMilestone(d) {
    d = Object.assign({}, d || {});
    if (!d.domain && typeof Journey !== 'undefined' && Journey.domainOf) d.domain = Journey.domainOf((d.milestoneText || '') + ' ' + (d.goalText || ''));
    d.op = 'milestone.complete';
    return post(d);
  }
  return { init, sync, status, createMetric, updateMetric, retireMetric, suppress, resume, reset, noteMilestone, _apply: apply };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = { JourneyStore };
