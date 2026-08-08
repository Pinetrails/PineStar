/* StarNet run recovery center -- local, human-led resolution and one-shot continuation for interrupted runs.
 * The UI never reconstructs tool arguments or dispatches directly: it records bounded operator verdicts, then
 * routes a prepared continuation through Harness.chat. The sidecar owns authorization, ownership, stale-state,
 * durability, replay prevention, and idempotency enforcement. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RunRecoveries = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const OUTCOMES = new Set(['happened', 'did_not_happen', 'unknown']);
  function normalizeRecovery(row) {
    row = row && typeof row === 'object' ? row : {};
    return {
      runId: String(row.runId || ''), agentId: String(row.agentId || ''), status: String(row.status || ''),
      recoveryToken: String(row.recoveryToken || ''), canResolve: row.canResolve === true,
      canContinue: row.canContinue === true, streamId: String(row.streamId || 'global'),
      title: String(row.cronJobName || row.userTitle || row.runId || 'Interrupted run').slice(0, 200),
      startedAt: Number(row.startedAt || 0), trigger: String(row.trigger || ''),
      corrupt: row.corrupt === true, forensicOnly: row.forensicOnly === true, repairError: String(row.repairError || ''),
      uncertain: (Array.isArray(row.uncertain) ? row.uncertain : []).map(x => ({
        callId: String((x && x.callId) || ''), name: String((x && x.name) || 'unknown tool')
      })).filter(x => x.callId),
      messages: (row.checkpoint && Array.isArray(row.checkpoint.messages) ? row.checkpoint.messages : []).slice(-30),
      resolution: row.resolution || null,
      continuation: row.continuation || null
    };
  }

  function makeResolutionPayload(row, choices, note, confirmed, resolutionId) {
    row = normalizeRecovery(row); choices = choices || {};
    if (!row.runId || !row.agentId || !row.recoveryToken) throw new Error('recovery snapshot is incomplete');
    if (!confirmed) throw new Error('confirm that no work will be replayed');
    const outcomes = row.uncertain.map(call => ({ callId: call.callId, outcome: String(choices[call.callId] || '') }));
    if (!outcomes.length || outcomes.some(x => !OUTCOMES.has(x.outcome))) throw new Error('choose an outcome for every uncertain call');
    return {
      runId: row.runId, agentId: row.agentId, recoveryToken: row.recoveryToken,
      resolutionId: String(resolutionId || ''), confirmedNoReplay: true, outcomes,
      note: String(note || '').slice(0, 500)
    };
  }

  function makeContinuationPayload(row, confirmed, continuationId) {
    row = normalizeRecovery(row);
    if (!row.runId || !row.agentId || !row.recoveryToken) throw new Error('recovery snapshot is incomplete');
    if (!row.resolution || !row.canContinue) throw new Error('this resolution cannot continue safely');
    if ((row.resolution.outcomes || []).some(x => x && x.outcome === 'unknown')) throw new Error('unknown outcomes cannot continue');
    if (!confirmed) throw new Error('confirm the one-shot safe continuation');
    return {
      runId: row.runId, agentId: row.agentId, recoveryToken: row.recoveryToken,
      continuationId: String(continuationId || ''), confirmedSafeContinuation: true
    };
  }

  function visibleRecoveries(rows) {
    return (rows || []).map(normalizeRecovery).filter(r => r.status === 'needs_review' || r.status === 'resolved');
  }

  function contentText(content) {
    if (typeof content === 'string') return content.slice(0, 4000);
    try { return JSON.stringify(content).slice(0, 4000); } catch (_) { return '[structured checkpoint content]'; }
  }
  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }
  function resolutionId() {
    try { if (crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (_) {}
    return 'local-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
  }

  function init(options) {
    options = options || {};
    if (typeof document === 'undefined' || document.getElementById('run-recovery-launcher')) return;
    const fetchFn = options.fetch || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    if (!fetchFn) return;
    const harness = options.harness || (typeof Harness !== 'undefined' ? Harness : null);
    const apiFetch = (url, init) => (harness && typeof harness.apiFetch === 'function') ? harness.apiFetch(url, init) : fetchFn(url, init);
    const style = el('style');
    style.textContent = [
      '#run-recovery-launcher{position:fixed;right:18px;top:68px;z-index:2147482000;border:1px solid #f0a13b;background:#2a1d10;color:#ffd89a;padding:9px 12px;font:700 12px/1.2 VT323,ui-monospace,monospace;letter-spacing:.06em;cursor:pointer;box-shadow:0 4px 18px #0009}',
      '#run-recovery-panel{position:fixed;right:18px;top:108px;z-index:2147481999;width:min(520px,calc(100vw - 36px));max-height:calc(100vh - 128px);overflow:auto;background:#11181b;color:#dce8e8;border:1px solid #f0a13b;box-shadow:0 12px 40px #000c;font:13px/1.45 VT323,ui-monospace,monospace}',
      '.rr-head{position:sticky;top:0;background:#182024;border-bottom:1px solid #566;padding:12px;display:flex;gap:10px;align-items:center}.rr-head strong{flex:1;color:#ffd89a}.rr-close{border:0;background:transparent;color:#ccd;cursor:pointer;font-size:18px}',
      '.rr-warning{margin:12px;padding:10px;border-left:3px solid #f0a13b;background:#2a2118;color:#ffe5bc}.rr-list{padding:0 12px 12px}.rr-card{border:1px solid #415056;background:#151d20;margin:10px 0;padding:12px}.rr-meta{color:#9fb1b6;font-size:11px;overflow-wrap:anywhere}.rr-call{border-top:1px solid #344248;margin-top:9px;padding-top:9px}.rr-call b{color:#f7c978}.rr-card select,.rr-card textarea{width:100%;box-sizing:border-box;margin-top:6px;background:#0c1214;color:#e7eeee;border:1px solid #526269;padding:7px;font:inherit}.rr-card textarea{min-height:54px;resize:vertical}.rr-context{margin:9px 0;color:#afc0c5}.rr-msg{white-space:pre-wrap;overflow-wrap:anywhere;border-left:2px solid #45555b;padding:5px 8px;margin:5px 0;color:#c6d3d6}.rr-consent{display:flex;gap:8px;margin:10px 0;color:#ffd89a}.rr-submit{border:1px solid #f0a13b;background:#352611;color:#ffe0ad;padding:8px 10px;font:700 12px VT323,ui-monospace,monospace;cursor:pointer}.rr-submit:disabled{opacity:.45;cursor:not-allowed}.rr-status{min-height:18px;margin-top:8px;color:#f2bd70}.rr-output{max-height:150px;overflow:auto;white-space:pre-wrap;background:#0c1214;border:1px solid #344248;padding:8px;color:#c9dbdf}.rr-permission{border:1px solid #cf8432;background:#281d12;padding:9px;margin-top:9px}.rr-permission button{margin:7px 7px 0 0}.rr-empty{padding:18px;color:#aebdc1}',
      '[hidden]{display:none!important}'
    ].join('');
    document.head.appendChild(style);

    const launcher = el('button', '', 'RUN RECOVERY'); launcher.id = 'run-recovery-launcher'; launcher.hidden = true;
    launcher.type = 'button'; launcher.setAttribute('aria-haspopup', 'dialog');
    const panel = el('section'); panel.id = 'run-recovery-panel'; panel.hidden = true;
    panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Interrupted run recovery');
    const head = el('div', 'rr-head'); head.appendChild(el('strong', '', 'INTERRUPTED RUN RECOVERY'));
    const refresh = el('button', 'rr-close', 'REFRESH'); refresh.type = 'button'; refresh.title = 'Reload recovery journals'; head.appendChild(refresh);
    const close = el('button', 'rr-close', 'X'); close.type = 'button'; close.setAttribute('aria-label', 'Close'); head.appendChild(close);
    panel.appendChild(head);
    panel.appendChild(el('div', 'rr-warning', 'Verify every uncertain outcome first. Safe continuation is one-shot and host-enforced: reviewed mutating calls cannot execute again.'));
    const list = el('div', 'rr-list'); panel.appendChild(list);
    document.body.appendChild(launcher); document.body.appendChild(panel);

    function appendContext(card, row) {
      const details = el('details', 'rr-context');
      details.appendChild(el('summary', '', 'Inspect checkpoint context (' + row.messages.length + ' messages)'));
      row.messages.forEach(m => details.appendChild(el('div', 'rr-msg', String((m && m.role) || 'message') + ': ' + contentText(m && m.content))));
      card.appendChild(details);
    }

    function renderResolved(card, row) {
      appendContext(card, row);
      const outcomes = (row.resolution && Array.isArray(row.resolution.outcomes)) ? row.resolution.outcomes : [];
      outcomes.forEach(x => card.appendChild(el('div', 'rr-meta', String(x.callId || '') + ' = ' + String(x.outcome || ''))));
      const unknown = outcomes.some(x => x && x.outcome === 'unknown');
      if (unknown) {
        card.appendChild(el('div', 'rr-status', 'Continuation blocked: at least one effect is still unknown. This journal remains forensic evidence.'));
        return;
      }
      const prior = row.continuation;
      if (prior && prior.state === 'started') {
        card.appendChild(el('div', 'rr-status', 'Continuation started as ' + String(prior.continuedRunId || 'another run') + '. It cannot be retried; review that run if it was interrupted.'));
        return;
      }
      if (prior && prior.state === 'finished') {
        card.appendChild(el('div', 'rr-status', 'Continuation finished: ' + String(prior.reason || 'complete') + '.'));
        return;
      }
      if (!row.canContinue) {
        card.appendChild(el('div', 'rr-status', 'This resolution cannot form a safe provider checkpoint. Preserve it for manual recovery.'));
        return;
      }
      if (!harness || typeof harness.chat !== 'function') {
        card.appendChild(el('div', 'rr-status', 'Safe continuation is unavailable until the local run harness is ready.'));
        return;
      }
      const consentLabel = el('label', 'rr-consent'); const consent = el('input'); consent.type = 'checkbox';
      consentLabel.appendChild(consent); consentLabel.appendChild(document.createTextNode('Continue once from the verified checkpoint. Reviewed mutating calls remain blocked by the host.'));
      card.appendChild(consentLabel);
      const start = el('button', 'rr-submit', 'CONTINUE SAFELY - BLOCK REVIEWED REPLAY'); start.type = 'button'; start.disabled = true; card.appendChild(start);
      const status = el('div', 'rr-status'); status.setAttribute('aria-live', 'polite'); card.appendChild(status);
      const output = el('pre', 'rr-output'); output.hidden = true; card.appendChild(output);
      const permission = el('div', 'rr-permission'); permission.hidden = true; card.appendChild(permission);
      consent.addEventListener('change', () => { start.disabled = !consent.checked; });
      start.addEventListener('click', async () => {
        const cid = (prior && prior.continuationId) || resolutionId();
        let payload;
        try { payload = makeContinuationPayload(row, consent.checked, cid); }
        catch (e) { status.textContent = e.message; return; }
        start.disabled = true; consent.disabled = true; status.textContent = 'Durably preparing one-shot continuation...';
        try {
          const response = await apiFetch('/api/run-recoveries/continue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
          const prepared = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(prepared.error || ('HTTP ' + response.status));
          if (!prepared.canStart || !prepared.continuationToken) { status.textContent = 'Continuation was already consumed and cannot be retried.'; await load(false); return; }
          status.textContent = 'Continuing from verified checkpoint...';
          let continuedRunId = '';
          const placed = (typeof World !== 'undefined' && World.heroCaps) ? (World.heroCaps(row.agentId) || []) : [];
          const stationPlaced = (typeof World !== 'undefined' && World.stationCaps) ? (World.stationCaps() || []) : [];
          const result = await harness.chat({
            system: '', messages: [], agentId: row.agentId, isTask: true, streamId: row.streamId,
            placed, stationPlaced,
            recovery: { sourceRunId: row.runId, continuationId: cid, continuationToken: prepared.continuationToken },
            onRunId: id => { continuedRunId = id; },
            onToken: delta => { output.hidden = false; output.textContent += String(delta || ''); },
            onToolCall: ev => { status.textContent = 'Tool: ' + String((ev && ev.name) || 'working'); },
            onToolResult: ev => { if (ev && ev.summary === 'recovery-replay-blocked') status.textContent = 'Reviewed replay blocked by host; continuation is proceeding safely.'; },
            onPermission: ev => {
              permission.replaceChildren(); permission.hidden = false;
              permission.appendChild(el('div', '', 'Permission required: ' + String((ev && ev.tool) || 'tool')));
              permission.appendChild(el('div', 'rr-meta', String((ev && ev.argsSummary) || '')));
              if (continuedRunId && ev && ev.promptId && harness.consentAck) harness.consentAck(continuedRunId, ev.promptId);
              const answer = (label, decision) => {
                const b = el('button', 'rr-submit', label); b.type = 'button';
                b.addEventListener('click', () => { permission.hidden = true; if (harness.consent) harness.consent(continuedRunId, ev.promptId, decision); });
                permission.appendChild(b);
              };
              answer('APPROVE ONCE', 'once'); answer('DENY', 'deny');
            }
          });
          status.textContent = result && result.error ? ('Continuation ended with error: ' + result.error) : ('Continuation finished: ' + String((result && result.endReason) || 'done'));
          await load(false);
        } catch (e) {
          status.textContent = 'Continuation did not start safely: ' + String((e && e.message) || e);
          await load(false);
        }
      });
    }

    function render(rows) {
      const active = visibleRecoveries(rows);
      launcher.hidden = active.length === 0;
      launcher.textContent = 'RUN RECOVERY | ' + active.length;
      list.replaceChildren();
      if (!active.length) { list.appendChild(el('div', 'rr-empty', 'No uncertain interrupted runs require review.')); return; }
      active.forEach(row => {
        const card = el('article', 'rr-card');
        card.appendChild(el('strong', '', row.title));
        const when = row.startedAt ? new Date(row.startedAt).toLocaleString() : 'time unavailable';
        card.appendChild(el('div', 'rr-meta', row.agentId + ' | ' + when + ' | ' + row.runId));
        if (row.status === 'resolved') {
          renderResolved(card, row); list.appendChild(card); return;
        }
        if (row.corrupt || row.repairError || !row.canResolve) {
          card.appendChild(el('div', 'rr-status', 'This journal cannot be safely resolved in-app; preserve it for forensic review.'));
          list.appendChild(card); return;
        }
        const details = el('details', 'rr-context');
        details.appendChild(el('summary', '', 'Inspect checkpoint context (' + row.messages.length + ' messages)'));
        row.messages.forEach(m => details.appendChild(el('div', 'rr-msg', String((m && m.role) || 'message') + ': ' + contentText(m && m.content))));
        card.appendChild(details);
        const choices = {};
        row.uncertain.forEach(call => {
          const box = el('div', 'rr-call'); box.appendChild(el('b', '', call.name));
          box.appendChild(el('div', 'rr-meta', 'call ' + call.callId));
          const select = el('select');
          [['', 'Choose verified outcome...'], ['happened', 'Verified: effect happened'], ['did_not_happen', 'Verified: effect did not happen'], ['unknown', 'Could not determine -- preserve uncertainty']].forEach(pair => {
            const opt = el('option', '', pair[1]); opt.value = pair[0]; select.appendChild(opt);
          });
          select.addEventListener('change', () => { choices[call.callId] = select.value; updateReady(); });
          box.appendChild(select); card.appendChild(box);
        });
        const note = el('textarea'); note.maxLength = 500; note.placeholder = 'Optional: where/how you verified the outcome (no secrets)'; card.appendChild(note);
        const consentLabel = el('label', 'rr-consent'); const consent = el('input'); consent.type = 'checkbox';
        consentLabel.appendChild(consent); consentLabel.appendChild(document.createTextNode('I verified every outcome and understand that no work will be replayed.')); card.appendChild(consentLabel);
        const submit = el('button', 'rr-submit', 'RECORD RESOLUTION -- NO REPLAY'); submit.type = 'button'; submit.disabled = true; card.appendChild(submit);
        const status = el('div', 'rr-status'); status.setAttribute('aria-live', 'polite'); card.appendChild(status);
        function updateReady() { submit.disabled = !consent.checked || row.uncertain.some(x => !OUTCOMES.has(choices[x.callId])); }
        consent.addEventListener('change', updateReady);
        submit.addEventListener('click', async () => {
          let payload; try { payload = makeResolutionPayload(row, choices, note.value, consent.checked, resolutionId()); }
          catch (e) { status.textContent = e.message; return; }
          submit.disabled = true; status.textContent = 'Recording durable resolution...';
          try {
            const response = await apiFetch('/api/run-recoveries/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
            const body = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(body.error || ('HTTP ' + response.status));
            status.textContent = 'Resolved. No work was replayed.'; await load(false);
          } catch (e) { status.textContent = 'Not resolved: ' + String((e && e.message) || e); updateReady(); }
        });
        list.appendChild(card);
      });
    }
    async function load(autoOpen) {
      try {
        const response = await apiFetch('/api/run-recoveries', { cache: 'no-store' });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const body = await response.json(); render(body.recoveries || []);
        if (autoOpen && !launcher.hidden) panel.hidden = false;
      } catch (_) { /* fail closed and quiet: no action surface without a current authenticated snapshot */ }
    }
    launcher.addEventListener('click', () => { panel.hidden = !panel.hidden; });
    close.addEventListener('click', () => { panel.hidden = true; });
    refresh.addEventListener('click', () => load(false));
    load(true);
    return { load, render, launcher, panel };
  }

  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => init(), { once: true });
    else setTimeout(() => init(), 0);
  }
  return { normalizeRecovery, makeResolutionPayload, makeContinuationPayload, visibleRecoveries, init };
});
