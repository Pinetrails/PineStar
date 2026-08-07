/* Safe continuation planning for interrupted run journals.
 *
 * This module is deliberately pure. It turns a resolved journal into provider-valid history and a host-enforced
 * replay barrier. Prompt context explains the operator's decision; the fingerprint barrier is the authority that
 * prevents an already-reviewed mutating call from executing again. */
'use strict';

const crypto = require('crypto');

function stable(value) {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
}

function canonicalArgs(argsRaw) {
  const raw = String(argsRaw == null ? '{}' : argsRaw);
  try { return stable(JSON.parse(raw)); } catch (_) { return raw; }
}

function replayFingerprint(name, argsRaw) {
  return crypto.createHash('sha256').update(String(name || '') + '\n' + canonicalArgs(argsRaw)).digest('hex');
}

function fail(message) {
  const e = new Error(message); e.code = 'RUN_CONTINUATION_BLOCKED'; throw e;
}

function cloneMessages(messages) {
  try { return JSON.parse(JSON.stringify(messages || [])); }
  catch (_) { fail('recovery checkpoint could not be cloned safely'); }
}

function continuationPlan(state) {
  state = state || {};
  if (state.corrupt || state.repairError || state.forensicOnly) fail('corrupt recovery journals remain forensic-only');
  if (!state.resolution || !Array.isArray(state.resolution.outcomes)) fail('operator resolution is required');
  if (state.resolution.outcomes.some(x => !x || x.outcome === 'unknown')) fail('unknown outcomes cannot continue');
  if (state.resolution.outcomes.some(x => !/^(?:happened|did_not_happen)$/.test(String(x.outcome || '')))) fail('every outcome must be verified');

  const uncertain = Array.isArray(state.uncertain) ? state.uncertain : [];
  if (!uncertain.length) fail('no reviewed uncertainty is available to continue');
  const outcomes = new Map(state.resolution.outcomes.map(x => [String(x.callId || ''), String(x.outcome || '')]));
  if (uncertain.some(x => !outcomes.has(String(x.callId || '')))) fail('resolution does not cover every uncertain call');

  const messages = cloneMessages(state.checkpoint && state.checkpoint.messages);
  if (!messages.length) fail('provider checkpoint is missing');
  const pending = new Map();
  for (const m of messages) {
    if (m && m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const c of m.tool_calls) if (c && c.id) pending.set(String(c.id), c);
    } else if (m && m.role === 'tool' && m.tool_call_id) {
      pending.delete(String(m.tool_call_id));
    } else if (pending.size) {
      fail('provider checkpoint contains an unpaired tool call before later context');
    }
  }
  const uncertainById = new Map(uncertain.map(x => [String(x.callId || ''), x]));
  for (const id of uncertainById.keys()) if (!pending.has(id)) fail('uncertain call is absent from the provider checkpoint');
  const completedById = new Map();
  for (const pair of (Array.isArray(state.completed) ? state.completed : [])) {
    const id = String((pair && pair.intent && pair.intent.callId) || (pair && pair.result && pair.result.callId) || '');
    if (id) completedById.set(id, pair);
  }

  const blockedFingerprints = [];
  const contextLines = [];
  for (const [callId] of pending) {
    const reviewed = uncertainById.get(callId);
    if (reviewed) {
      const outcome = outcomes.get(callId);
      if (reviewed.mutating !== false) {
        const fp = String(reviewed.replayFingerprint || '');
        if (!/^[a-f0-9]{64}$/.test(fp)) fail('reviewed mutation lacks a durable replay fingerprint');
        blockedFingerprints.push(fp);
      }
      const name = String(reviewed.name || 'tool');
      const verdict = outcome === 'happened' ? 'happened' : 'did not happen';
      const replayRule = reviewed.mutating !== false
        ? ' This reviewed mutating call is closed; the host will not execute it again in this continuation.'
        : ' This reviewed read result is closed and supplied as operator-verified context.';
      messages.push({
        role: 'tool', tool_call_id: callId,
        content: 'OPERATOR-VERIFIED RECOVERY: the uncertain `' + name + '` effect ' + verdict + ' before the crash.' + replayRule
      });
      contextLines.push(name + ' (' + callId + '): verified ' + verdict + (reviewed.mutating !== false ? '; mutating replay blocked' : '; read result supplied'));
      continue;
    }
    const completed = completedById.get(callId);
    if (!completed || !completed.result) fail('provider checkpoint has a tool call with no durable result or operator verdict');
    const result = completed.result;
    const content = String(result.content == null ? '' : result.content);
    messages.push({ role: 'tool', tool_call_id: callId, content: result.isError ? ('ERROR: ' + content) : content });
  }
  const context = 'Safe continuation of interrupted run ' + String(state.runId || '') + '. Operator resolution:\n- '
    + contextLines.join('\n- ')
    + '\nNo reviewed mutating call may be replayed. Continue from the paired results above; if further work would require an identical blocked call, stop and tell the operator.';
  messages.push({ role: 'system', content: '<operator_resolution>\n' + context + '\n</operator_resolution>' });
  return { messages, context, blockedFingerprints: Array.from(new Set(blockedFingerprints)).sort() };
}

function makeReplayBarrier(fingerprints) {
  const blocked = new Set((Array.isArray(fingerprints) ? fingerprints : []).map(String));
  return {
    check(name, argsRaw, mutating) {
      if (!mutating) return { ok: true };
      const fingerprint = replayFingerprint(name, argsRaw);
      return blocked.has(fingerprint)
        ? { ok: false, fingerprint, reason: 'reviewed mutation replay blocked' }
        : { ok: true, fingerprint };
    },
    fingerprints: () => Array.from(blocked).sort()
  };
}

module.exports = { replayFingerprint, continuationPlan, makeReplayBarrier, _internals: { stable, canonicalArgs } };
