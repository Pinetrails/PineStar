/* Per-run mutable execution state.

   The run host owns policy and IO; this object owns the bookkeeping that must evolve consistently across tool
   dispatches. Keeping the counters and latches together makes their lifecycle explicit and prevents a future
   early-return or fallback path from quietly creating a second, partially updated copy. */
'use strict';

function makeRunExecutionState(options) {
  const opts = options || {};
  const artifacts = opts.artifacts;
  const failures = new Map();
  let taintedBy = opts.initialTaint ? String(opts.initialTaint) : null;
  let toolBytes = 0;
  let toolsOk = 0;
  let toolCallsStarted = 0;
  const toolTrace = [];
  const toolTraceById = new Map();
  let checkpointTurn = 0;
  let journalStarted = false;

  function latchTaint(source) {
    if (!taintedBy && source) taintedBy = String(source);
    return taintedBy;
  }

  function repeated(signature, maxRepeat) {
    return (failures.get(String(signature)) || 0) > Math.max(0, Number(maxRepeat) || 0);
  }

  function recordResult(signature, result, internal) {
    const key = String(signature);
    if (result && result.isError) failures.set(key, (failures.get(key) || 0) + 1);
    else failures.delete(key);
    if (result && !result.isError && !internal) toolsOk++;
  }

  function boundToolResult(result, maxBytes, messages) {
    if (!result || typeof result.content !== 'string') return result;
    const cap = Math.max(0, Number(maxBytes) || 0);
    let next = result;
    const copy = messages || {};
    if (toolBytes >= cap) {
      next = Object.assign({}, result, { content: copy.omitted || '[tool output omitted — per-run tool-output budget reached]' });
    } else if (toolBytes + result.content.length > cap) {
      next = Object.assign({}, result, { content: result.content.slice(0, cap - toolBytes) + (copy.truncatedSuffix || '\n…[truncated — per-run tool-output budget reached]') });
    }
    toolBytes += next.content.length;
    return next;
  }

  function observeArtifact(event) {
    if (artifacts && typeof artifacts.observe === 'function') artifacts.observe(event);
  }

  function artifactList() {
    return artifacts && typeof artifacts.list === 'function' ? artifacts.list() : [];
  }

  function consumeToolCall(maxCalls) {
    const cap = Math.floor(Number(maxCalls) || 0);
    if (cap > 0 && toolCallsStarted >= cap) return false;
    toolCallsStarted++;
    return true;
  }

  function observeToolEvent(name, payload, now) {
    const at = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    if (name === 'agent.tool_call' && payload && payload.callId && toolTrace.length < 200) {
      const rec = { callId: String(payload.callId), name: String(payload.name || 'unknown'), startedAt: at };
      toolTrace.push(rec);
      toolTraceById.set(rec.callId, rec);
    } else if (name === 'agent.tool_result' && payload && payload.callId) {
      const rec = toolTraceById.get(String(payload.callId));
      if (!rec) return;
      rec.ok = !!payload.ok;
      rec.isError = !!payload.isError;
      rec.ms = Math.max(0, Number(payload.ms) || 0);
      rec.endedAt = rec.startedAt + rec.ms;
      rec.summary = String(payload.summary || '').slice(0, 240);
    }
  }

  function toolTraceList() {
    return toolTrace.map(rec => Object.assign({}, rec));
  }

  return {
    taintedBy: () => taintedBy,
    latchTaint,
    repeated,
    recordResult,
    boundToolResult,
    resetToolBytes: () => { toolBytes = 0; },
    toolBytes: () => toolBytes,
    toolsOk: () => toolsOk,
    consumeToolCall,
    toolCallsStarted: () => toolCallsStarted,
    observeToolEvent,
    toolTraceList,
    checkpointTurn: () => checkpointTurn,
    advanceCheckpoint: () => { checkpointTurn++; return checkpointTurn; },
    journalStarted: () => journalStarted,
    startJournal: () => { journalStarted = true; },
    observeArtifact,
    artifactList
  };
}

module.exports = { makeRunExecutionState };
