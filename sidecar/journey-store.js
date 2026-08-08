/* sidecar/journey-store.js — durable Commander-journey progression.

   This is deliberately NOT XP. XP remains the agent/Commander feedback relationship; this store records the
   separate causal spine the game was missing:

     explicit goal -> verified quest/milestone/metric outcome -> domain mastery -> adaptation receipt ->
     station evolution

   Every outcome carries its authority. Mechanical quest contracts are `harness-contract`; attest quests are
   `commander-confirmed`; goal milestones and metric updates are `commander-client` because their authoritative
   owners currently live in the webview. No bare run, tool count, spend, or model claim can enter this ledger.

   Station evolution is expressive only. It never grants tools, capabilities, permission, or model access. */
'use strict';

const { makeDurableJsonStore } = require('./durable-store.js');

const STORE_KEY = 'station';
const STORE_FILE = '_station.journey.json';
const DOMAINS = ['building', 'research', 'writing', 'growth', 'operations', 'creative', 'planning', 'support'];
const DOMAIN_SET = new Set(DOMAINS);
const OUTCOME_KINDS = new Set(['quest', 'milestone', 'metric']);
const TIER_STEPS = [[7, 'proven'], [3, 'practiced'], [1, 'tested']];
const EVOLUTION_NAMES = ['DRIFT', 'VECTOR', 'ORBIT', 'CONSTELLATION', 'DEEP FIELD'];
const METRIC_CAP = 40, OUTCOME_CAP = 300, RECEIPT_CAP = 100, GOAL_CAP = 40, HISTORY_CAP = 24;
const AGENT_RE = /^[A-Za-z0-9_-]{1,40}$/;

const clip = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
const finite = v => typeof v === 'number' && Number.isFinite(v);
const number = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const stamp = v => Math.max(0, Math.floor(number(v) || 0));
const domain = v => DOMAIN_SET.has(String(v || '').toLowerCase()) ? String(v).toLowerCase() : null;
const agent = v => AGENT_RE.test(String(v || '')) ? String(v) : null;

function tierFor(count) {
  const n = Math.max(0, Number(count) | 0);
  const hit = TIER_STEPS.find(row => n >= row[0]);
  return hit ? hit[1] : 'unproven';
}

function evolutionFor(goalsReached) {
  const n = Array.isArray(goalsReached) ? goalsReached.length : 0;
  const base = EVOLUTION_NAMES[Math.min(EVOLUTION_NAMES.length - 1, n)];
  return { stage: n, name: n > 4 ? ('DEEP FIELD ' + (n - 3)) : base, goalsReached: n };
}

function normMetric(m) {
  if (!m || typeof m !== 'object') return null;
  const id = clip(m.id, 48), label = clip(m.label, 100), baseline = number(m.baseline), target = number(m.target), current = number(m.current);
  if (!id || !label || baseline == null || target == null || current == null || baseline === target) return null;
  const direction = target > baseline ? 'atLeast' : 'atMost';
  const history = (Array.isArray(m.history) ? m.history : []).map(h => {
    const value = number(h && h.value); if (value == null) return null;
    return { at: stamp(h.at), value, note: clip(h.note, 240), source: h.source === 'commander' ? 'commander' : 'migration' };
  }).filter(Boolean).slice(-HISTORY_CAP);
  return {
    id, goalId: clip(m.goalId, 64) || null, label, unit: clip(m.unit, 24), baseline, target, current, direction,
    status: m.status === 'retired' ? 'retired' : 'active', createdAt: stamp(m.createdAt), updatedAt: stamp(m.updatedAt),
    reachedAt: m.reachedAt == null ? null : stamp(m.reachedAt), history
  };
}

function normOutcome(o) {
  if (!o || typeof o !== 'object') return null;
  const sourceId = clip(o.sourceId, 120), kind = String(o.kind || '');
  if (!sourceId || !OUTCOME_KINDS.has(kind)) return null;
  return {
    id: clip(o.id, 48), sourceId, kind, goalId: clip(o.goalId, 64) || null,
    milestoneId: clip(o.milestoneId, 80) || null, questId: clip(o.questId, 48) || null,
    agentId: agent(o.agentId), domain: domain(o.domain), title: clip(o.title, 140), evidence: clip(o.evidence, 1000),
    verifiedBy: ['harness-contract', 'commander-confirmed', 'commander-client'].includes(o.verifiedBy) ? o.verifiedBy : 'commander-client',
    goalDone: !!o.goalDone, at: stamp(o.at)
  };
}

function normMastery(m) {
  if (!m || typeof m !== 'object') return null;
  const aid = agent(m.agentId), d = domain(m.domain), count = Math.max(0, Number(m.count) | 0);
  if (!aid || !d || !count) return null;
  return { agentId: aid, domain: d, count, tier: tierFor(count), lastAt: stamp(m.lastAt), lastOutcomeId: clip(m.lastOutcomeId, 48) || null };
}

function normReceipt(r) {
  if (!r || typeof r !== 'object') return null;
  const id = clip(r.id, 48), aid = agent(r.agentId), d = domain(r.domain);
  if (!id || !aid || !d) return null;
  return {
    id, agentId: aid, domain: d, tier: tierFor(r.count), count: Math.max(1, Number(r.count) | 0),
    text: clip(r.text, 360), outcomeId: clip(r.outcomeId, 48) || null, at: stamp(r.at),
    dismissedAt: r.dismissedAt == null ? null : stamp(r.dismissedAt)
  };
}

function normalize(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const metrics = (Array.isArray(r.metrics) ? r.metrics : []).map(normMetric).filter(Boolean).slice(-METRIC_CAP);
  const outcomes = (Array.isArray(r.outcomes) ? r.outcomes : []).map(normOutcome).filter(Boolean).slice(-OUTCOME_CAP);
  const mastery = (Array.isArray(r.mastery) ? r.mastery : []).map(normMastery).filter(Boolean);
  const receipts = (Array.isArray(r.receipts) ? r.receipts : []).map(normReceipt).filter(Boolean).slice(-RECEIPT_CAP);
  const goalsReached = [...new Set((Array.isArray(r.goalsReached) ? r.goalsReached : []).map(v => clip(v, 64)).filter(Boolean))].slice(-GOAL_CAP);
  const suppressed = {};
  if (r.suppressed && typeof r.suppressed === 'object') {
    for (const [aid, dims] of Object.entries(r.suppressed)) {
      if (!agent(aid) || !dims || typeof dims !== 'object') continue;
      const clean = {};
      for (const [d, at] of Object.entries(dims)) if (domain(d)) clean[d] = stamp(at);
      if (Object.keys(clean).length) suppressed[aid] = clean;
    }
  }
  return { v: 1, seq: Math.max(0, Number(r.seq) | 0), metrics, outcomes, mastery, receipts, goalsReached, suppressed };
}

function reached(metric) {
  return metric.direction === 'atMost' ? metric.current <= metric.target : metric.current >= metric.target;
}

function addGoalReached(rec, goalId) {
  const id = clip(goalId, 64);
  if (id && rec.goalsReached.indexOf(id) < 0) {
    rec.goalsReached.push(id);
    while (rec.goalsReached.length > GOAL_CAP) rec.goalsReached.shift();
  }
}

function adaptationText(m, outcome) {
  const title = clip(outcome && outcome.title, 90) || 'verified work';
  const posture = m.tier === 'proven' ? 'reuse established patterns'
    : m.tier === 'practiced' ? 'prefer relevant repeated patterns while stating uncertainty'
      : 'consider the early pattern but verify it before relying on it';
  return 'Because ' + m.agentId + ' completed ' + m.count + ' verified ' + m.domain + ' outcome' + (m.count === 1 ? '' : 's')
    + ' (latest: ' + title + '), StarNet will ' + posture + ' for this agent and surface uncertainty outside that track.';
}

// Mutates a normalized record inside the durable store update. sourceId is the idempotency authority.
function foldOutcome(rec, input, now) {
  const d = normOutcome(Object.assign({}, input, { at: stamp(now) }));
  if (!d || rec.outcomes.some(o => o.sourceId === d.sourceId)) return { changed: false, outcome: null, receipt: null };
  d.id = 'jo:' + (++rec.seq);
  rec.outcomes.push(d);
  while (rec.outcomes.length > OUTCOME_CAP) rec.outcomes.shift();
  if (d.goalDone) addGoalReached(rec, d.goalId || d.sourceId);

  let receipt = null;
  if (d.agentId && d.domain) {
    let m = rec.mastery.find(x => x.agentId === d.agentId && x.domain === d.domain);
    const before = m ? m.tier : 'unproven';
    if (!m) { m = { agentId: d.agentId, domain: d.domain, count: 0, tier: 'unproven', lastAt: 0, lastOutcomeId: null }; rec.mastery.push(m); }
    m.count += 1; m.tier = tierFor(m.count); m.lastAt = d.at; m.lastOutcomeId = d.id;
    if (m.tier !== before) {
      receipt = { id: 'jr:' + (++rec.seq), agentId: m.agentId, domain: m.domain, tier: m.tier, count: m.count,
        text: adaptationText(m, d), outcomeId: d.id, at: d.at, dismissedAt: null };
      rec.receipts.push(receipt);
      while (rec.receipts.length > RECEIPT_CAP) rec.receipts.shift();
    }
  }
  return { changed: true, outcome: d, receipt };
}

function makeJourneyStore(deps) {
  deps = deps || {};
  if (!deps.path || !deps.workspaces) throw new Error('makeJourneyStore requires path + workspaces');
  const durable = makeDurableJsonStore({
    fs: deps.fs, path: deps.path, fileFor: () => deps.path.join(deps.workspaces, STORE_FILE),
    writeDurable: deps.writeDurable, onRecover: deps.onRecover, onCorrupt: deps.onCorrupt
  });

  function read() { try { return normalize(durable.get(STORE_KEY)); } catch (_) { return normalize(null); } }

  function snapshot(activeGoal) {
    const rec = read();
    return {
      v: rec.v,
      activeGoal: activeGoal && typeof activeGoal === 'object' ? {
        id: clip(activeGoal.id, 64) || null, text: clip(activeGoal.text, 280), done: Math.max(0, Number(activeGoal.done) | 0),
        total: Math.max(0, Number(activeGoal.total) | 0), next: clip(activeGoal.next, 200) || null
      } : null,
      metrics: rec.metrics.filter(m => m.status !== 'retired'),
      outcomes: rec.outcomes.slice(-50), mastery: rec.mastery.slice(), receipts: rec.receipts.slice(-20),
      suppressed: rec.suppressed, evolution: evolutionFor(rec.goalsReached)
    };
  }

  async function recordQuest(q, activeGoal, now) {
    if (!q || !q.id || q.status !== 'done') return { ok: false, error: 'a completed quest is required' };
    const attest = q.attest && q.attest.confirmed === true ? q.attest : null;
    if (q.contract && q.contract.type === 'attest' && !attest) return { ok: false, error: 'attest completion requires Commander-confirmed evidence' };
    const aid = agent(q.completedBy) || agent(attest && attest.agentId) || agent(q.agentId);
    const proof = q.contract && q.contract.type === 'attest' ? 'commander-confirmed' : 'harness-contract';
    const evidence = attest && attest.evidence
      ? attest.evidence
      : ((q.contract && q.contract.type) ? (q.contract.type + ':' + String(q.contract.key || '')) : 'verified quest completion');
    let result = null;
    await durable.update(STORE_KEY, cur => {
      const rec = normalize(cur);
      result = foldOutcome(rec, {
        sourceId: 'quest:' + q.id, kind: 'quest', questId: q.id, goalId: q.goalId,
        milestoneId: q.milestoneId, agentId: aid, domain: q.domain, title: q.title, evidence, verifiedBy: proof, goalDone: false
      }, now);
      return result.changed ? rec : undefined;
    });
    return { ok: true, duplicate: !result.changed, outcome: result.outcome, receipt: result.receipt };
  }

  async function recordMilestone(d, now) {
    d = d || {}; let result = null;
    const sourceId = 'milestone:' + clip(d.goalId, 64) + ':' + clip(d.milestoneId, 80);
    if (!clip(d.goalId, 64) || !clip(d.milestoneId, 80) || clip(d.evidence, 1000).length < 4) return { ok: false, error: 'goal, milestone, and evidence are required' };
    await durable.update(STORE_KEY, cur => {
      const rec = normalize(cur);
      result = foldOutcome(rec, {
        sourceId, kind: 'milestone', goalId: d.goalId, milestoneId: d.milestoneId, agentId: d.agentId,
        domain: d.domain, title: d.milestoneText || d.goalText, evidence: d.evidence, verifiedBy: 'commander-client', goalDone: !!d.goalDone
      }, now);
      return result.changed ? rec : undefined;
    });
    return { ok: true, duplicate: !result.changed, outcome: result.outcome, receipt: result.receipt };
  }

  async function createMetric(d, now) {
    d = d || {}; const label = clip(d.label, 100), baseline = number(d.baseline), target = number(d.target);
    if (!label || baseline == null || target == null || baseline === target) return { ok: false, error: 'label and distinct numeric baseline/target are required' };
    let metric = null;
    await durable.update(STORE_KEY, cur => {
      const rec = normalize(cur);
      const id = 'jm:' + (++rec.seq);
      metric = normMetric({ id, goalId: d.goalId, label, unit: d.unit, baseline, target, current: baseline,
        status: 'active', createdAt: now, updatedAt: now, reachedAt: null, history: [{ at: now, value: baseline, note: 'baseline', source: 'commander' }] });
      rec.metrics.push(metric); while (rec.metrics.length > METRIC_CAP) rec.metrics.shift();
      return rec;
    });
    return { ok: true, metric };
  }

  async function updateMetric(d, now) {
    d = d || {}; const id = clip(d.id, 48), value = number(d.current); let metric = null, outcome = null;
    if (!id || value == null) return { ok: false, error: 'metric id and numeric current value are required' };
    await durable.update(STORE_KEY, cur => {
      const rec = normalize(cur); const m = rec.metrics.find(x => x.id === id && x.status === 'active');
      if (!m) return undefined;
      m.current = value; m.updatedAt = stamp(now);
      m.history.push({ at: stamp(now), value, note: clip(d.note, 240), source: 'commander' });
      while (m.history.length > HISTORY_CAP) m.history.shift();
      if (reached(m) && m.reachedAt == null) {
        m.reachedAt = stamp(now);
        outcome = foldOutcome(rec, { sourceId: 'metric:' + m.id + ':reached', kind: 'metric', goalId: m.goalId,
          title: m.label + ' reached ' + m.target + (m.unit ? ' ' + m.unit : ''), evidence: 'Commander recorded ' + value + (m.unit ? ' ' + m.unit : ''),
          verifiedBy: 'commander-client', goalDone: false }, now);   // one metric target proves itself, never the whole life goal
      }
      metric = Object.assign({}, m); return rec;
    });
    return metric ? { ok: true, metric, outcome: outcome && outcome.outcome } : { ok: false, error: 'no such active metric' };
  }

  async function retireMetric(id, now) {
    let changed = false;
    await durable.update(STORE_KEY, cur => {
      const rec = normalize(cur), m = rec.metrics.find(x => x.id === String(id) && x.status === 'active');
      if (!m) return undefined; m.status = 'retired'; m.updatedAt = stamp(now); changed = true; return rec;
    });
    return { ok: changed };
  }

  async function setSuppressed(agentId, d, on, now) {
    const aid = agent(agentId), dom = domain(d); if (!aid || !dom) return { ok: false, error: 'valid agent and domain required' };
    await durable.update(STORE_KEY, cur => {
      const rec = normalize(cur); rec.suppressed[aid] = rec.suppressed[aid] || {};
      if (on) rec.suppressed[aid][dom] = stamp(now); else delete rec.suppressed[aid][dom];
      if (!Object.keys(rec.suppressed[aid]).length) delete rec.suppressed[aid];
      for (const r of rec.receipts) if (r.agentId === aid && r.domain === dom) r.dismissedAt = on ? stamp(now) : null;
      return rec;
    });
    return { ok: true, suppressed: !!on };
  }

  async function reset() {
    await durable.update(STORE_KEY, () => normalize(null));
    return { ok: true };
  }

  function adaptationBlock(agentId) {
    const aid = agent(agentId); if (!aid) return '';
    const rec = read(), muted = rec.suppressed[aid] || {};
    const rows = rec.mastery.filter(m => m.agentId === aid && !muted[m.domain]).sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain));
    if (!rows.length) return '';
    const lines = ['<VERIFIED_JOURNEY_ADAPTATION>', 'Use this agent\'s verified outcome history as a planning prior, never as permission or proof about a new task:'];
    for (const m of rows.slice(0, 5)) {
      const instruction = m.tier === 'proven' ? 'Reuse established patterns.'
        : m.tier === 'practiced' ? 'Prefer relevant repeated patterns, while stating uncertainty.'
          : 'Treat this as early evidence; consider the pattern but verify it.';
      lines.push('- ' + m.domain + ': ' + m.count + ' verified outcome' + (m.count === 1 ? '' : 's') + ' (' + m.tier + '). ' + instruction + ' State uncertainty outside this track.');
    }
    lines.push('</VERIFIED_JOURNEY_ADAPTATION>');
    return lines.join('\n');
  }

  return { read, snapshot, recordQuest, recordMilestone, createMetric, updateMetric, retireMetric, setSuppressed, reset, adaptationBlock, _durable: durable };
}

module.exports = { makeJourneyStore, normalize, tierFor, evolutionFor, DOMAINS, _internals: { normMetric, normOutcome, reached, foldOutcome } };
