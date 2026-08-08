/* Per-run mutable execution state.

   The run host owns policy and IO; this object owns the bookkeeping that must evolve consistently across tool
   dispatches. Keeping the counters and latches together makes their lifecycle explicit and prevents a future
   early-return or fallback path from quietly creating a second, partially updated copy. */
'use strict';

function makeRunExecutionState(options) {
  const opts = options || {};
  const artifacts = opts.artifacts;
  const injectedNow = typeof opts.now === 'function' ? opts.now : () => 0;
  const failures = new Map();
  let taintedBy = opts.initialTaint ? String(opts.initialTaint) : null;
  let toolBytes = 0;
  let toolsOk = 0;
  let toolCallsStarted = 0;
  const toolTrace = [];
  const toolTraceById = new Map();
  let checkpointTurn = 0;
  let journalStarted = false;
  let journalFailure = null;

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
    const originalChars = Number.isFinite(Number(result.outputChars))
      ? Math.max(0, Math.floor(Number(result.outputChars))) : result.content.length;
    const summary = String(result.summary || '').replace(/\s+/g, ' ').trim().slice(0, 240);
    const parkedPath = String(result.parkedPath || '').trim();
    const receipt = (summary || parkedPath) ? ('[Tool result receipt' + (summary ? ': ' + summary : '') + '. '
      + (parkedPath
        ? 'The full ' + originalChars + '-character output was saved to ' + parkedPath
          + ' because this run reached its context allowance. The tool already completed; do not rerun it merely to recover output. Read the saved file in focused ranges.'
        : originalChars + ' characters were returned, but the full output could not fit or be preserved. Narrow the command before rerunning it.')
      + ']') : '';
    if (toolBytes >= cap) {
      next = Object.assign({}, result, { content: receipt || copy.omitted || '[tool output omitted — per-run tool-output budget reached]', outputBounded: true });
    } else if (toolBytes + result.content.length > cap) {
      const available = cap - toolBytes;
      if (receipt) {
        const separator = '\n\n';
        const room = Math.max(0, available - receipt.length - separator.length * 2);
        const head = Math.floor(room * 0.6);
        const tail = room - head;
        const preview = room > 0
          ? result.content.slice(0, head) + separator + receipt + separator + result.content.slice(result.content.length - tail)
          : receipt;
        next = Object.assign({}, result, { content: preview, outputBounded: true });
      } else {
        next = Object.assign({}, result, { content: result.content.slice(0, available) + (copy.truncatedSuffix || '\n…[truncated — per-run tool-output budget reached]'), outputBounded: true });
      }
    }
    toolBytes += next.content.length;
    return next;
  }

  function willBoundToolResult(result, maxBytes) {
    if (!result || typeof result.content !== 'string') return false;
    const cap = Math.max(0, Number(maxBytes) || 0);
    return toolBytes >= cap || toolBytes + result.content.length > cap;
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

  function observeToolEvent(name, payload, atMs) {
    const at = Number.isFinite(Number(atMs)) ? Number(atMs) : Number(injectedNow()) || 0;
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

  function failJournal(error) {
    if (!journalFailure) journalFailure = String((error && error.message) || error || 'unknown journal failure').slice(0, 500);
    return {
      ok: false,
      isError: true,
      summary: 'recovery-journal-failed',
      content: 'The tool returned, but its durable recovery result could not be recorded. The outcome requires review; do not repeat the action or claim completion.',
      control: {
        final: true,
        reason: 'error',
        text: 'I stopped because the durable recovery boundary failed after a tool call. That tool outcome requires review, so I cannot safely claim the task completed.'
      }
    };
  }

  return {
    taintedBy: () => taintedBy,
    latchTaint,
    repeated,
    recordResult,
    boundToolResult,
    willBoundToolResult,
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
    journalFailed: () => !!journalFailure,
    journalFailure: () => journalFailure,
    failJournal,
    observeArtifact,
    artifactList
  };
}

module.exports = { makeRunExecutionState };
