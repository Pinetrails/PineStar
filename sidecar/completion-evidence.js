/* Structured completion evidence.
 *
 * This module deliberately does NOT answer "did the agent complete the user's task?" from a successful tool
 * result or a tool-name heuristic. It records narrower facts the host can prove about effects and verification
 * performed after them. Task completion remains `not_assessed` until a future typed task contract binds the
 * requested postcondition to compatible evidence.
 *
 * In particular, a browser screenshot/read or connector get/list after a mutation is candidate evidence that
 * requires semantic judgment. Observing *some* state after an action is not proof that the requested state was
 * observed. False completion is worse than an explicit unverified outcome. */
'use strict';

const MAX_ROWS = 100;
const MAX_TEXT = 160;

function text(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max || MAX_TEXT); }
function key(name) { return String(name == null ? '' : name).toLowerCase().replace(/\./g, '_'); }

function domainOf(name) {
  const k = key(name);
  if (/^mcp__.+__/.test(k)) return 'external';
  if (/^browser_/.test(k)) return 'browser';
  if (/^(?:fs_|shell_|verify_)/.test(k)) return 'workspace';
  return 'other';
}

function connectorOf(name) {
  const n = String(name == null ? '' : name).toLowerCase();
  const m = /^mcp__([^_]+(?:_[^_]+)*)__/.exec(n);
  return m ? m[1] : '';
}

function targetOf(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return '';
  for (const k of ['path', 'file', 'filename', 'target', 'url', 'id', 'documentId', 'pageId', 'sheetId']) {
    if (typeof args[k] === 'string' && args[k]) return text(args[k], MAX_TEXT);
  }
  return '';
}

function isVerifier(name) { return key(name) === 'verify_run'; }
function isObservation(name, scope) {
  if (scope === 'read') return true;
  return /(^|_)(?:read|get|list|fetch|status|inspect|snapshot|screenshot|check|verify|confirm|query|lookup)(_|$)/.test(key(name));
}

function makeCompletionEvidence() {
  const effects = [];
  const evidence = [];
  let seq = 0;

  function addEvidence(row) {
    if (evidence.length >= MAX_ROWS) return '';
    const id = 'ev-' + (++seq);
    evidence.push(Object.assign({ id }, row));
    return id;
  }

  function observe(event) {
    event = event || {};
    const result = event.result || {};
    if (!result.ok || result.isError) return;
    const name = text(event.name || (event.call && event.call.name), 80);
    const callId = text(event.callId || (event.call && event.call.id), 100);
    const scope = text(event.scope || (event.tool && event.tool.scope), 20).toLowerCase();
    const args = event.args || (event.call && event.call.args) || {};
    const domain = domainOf(name);
    const connector = connectorOf(name);

    // verify.run is a typed deterministic check only when its own verdict says PASS. Tool transport success is
    // insufficient: verify.run deliberately returns ordinary output for a failing command too.
    if (isVerifier(name)) {
      const passed = /^verify passed\b/i.test(String(result.summary || ''));
      const evidenceId = addEvidence({
        callId, tool: name, kind: 'deterministic_check', strength: passed ? 'mechanical' : 'failed',
        summary: text(result.summary, 120)
      });
      if (passed) {
        for (const effect of effects) {
          if (effect.domain !== 'workspace') continue;
          effect.state = 'mechanically_verified';
          if (evidenceId && effect.evidence.indexOf(evidenceId) < 0) effect.evidence.push(evidenceId);
        }
      }
      return;
    }

    // Connector scope annotations come from the remote server and are not completion authority. Match the
    // existing conservative host posture: only a familiar observation verb is treated as a read; unknown MCP
    // tools are effects even when a server labels them read-only.
    const mutating = domain === 'external' ? !isObservation(name, '') : (scope && scope !== 'read');
    if (mutating) {
      if (effects.length >= MAX_ROWS) return;
      const receipt = result.mutationReceipt || result.receipt || null;
      const readBack = !!(receipt && receipt.state === 'read-back-verified');
      const evidenceIds = [];
      if (readBack) {
        const id = addEvidence({
          callId, tool: name, kind: 'mutation_readback', strength: 'mechanical',
          summary: text(result.summary, 120)
        });
        if (id) evidenceIds.push(id);
      }
      effects.push({
        callId, tool: name, domain, connector, target: targetOf(args),
        state: readBack ? 'mechanically_verified' : ((domain === 'browser' || domain === 'external') ? 'judgment_required' : 'unverified'),
        evidence: evidenceIds
      });
      return;
    }

    if (!isObservation(name, scope)) return;
    // A later observation is retained as candidate evidence but cannot automatically prove an exact requested
    // browser/external postcondition. Keep the effect judgment-required and expose the linkage for a verifier.
    for (const effect of effects) {
      const sameDomain = effect.domain === domain;
      const sameExternal = domain !== 'external' || (connector && connector === effect.connector);
      if (!sameDomain || !sameExternal || effect.state === 'mechanically_verified') continue;
      const id = addEvidence({
        callId, tool: name, kind: 'post_effect_observation', strength: 'judgment_required',
        summary: text(result.summary, 120), coversCallId: effect.callId
      });
      if (id) effect.evidence.push(id);
      effect.state = 'judgment_required';
    }
  }

  function snapshot() {
    let effectVerdict = 'no_observed_effects';
    if (effects.length) {
      if (effects.some(e => e.state === 'unverified')) effectVerdict = 'unverified_effects';
      else if (effects.some(e => e.state === 'judgment_required')) effectVerdict = 'judgment_required';
      else effectVerdict = 'mechanically_verified';
    }
    return {
      schemaVersion: 'starnet.completion-evidence.v1',
      // Load-bearing: evidence about effects is not automatically evidence that the user's requested outcome
      // was correct, complete, or observed. Only a typed task/postcondition contract may change this later.
      completionVerdict: 'not_assessed',
      effectVerdict,
      effects: effects.map(e => Object.assign({}, e, { evidence: e.evidence.slice() })),
      evidence: evidence.map(e => Object.assign({}, e))
    };
  }

  return { observe, snapshot };
}

module.exports = { makeCompletionEvidence, _internals: { domainOf, connectorOf, targetOf, isVerifier, isObservation } };
