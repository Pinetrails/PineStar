/* shared/events.js — the FROZEN U.bus event contract.
   Every cross-boundary event the harness emits lives here with a payload schema.
   validate(name, payload) runs at the bus boundary in BOTH directions; the whole
   set is frozen up front (incl. tool / reasoning / budget events) so the loop,
   reasoning display, and budget UI never force a re-freeze. */
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./schema.js'));
  else { root.SK = root.SK || {}; root.SK.events = factory(root.SK.schema); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (schema) {
  'use strict';

  const SCHEMA_VERSION = 1;

  const str = { type: 'string' };
  const num = { type: 'number' };
  const int = { type: 'integer' };
  const bool = { type: 'boolean' };
  const any = {};
  const obj = (required, properties) => ({ type: 'object', required, properties });

  const EVENTS = {
    // ---- agent runtime (frozen) ----
    'agent.run.start': obj(['agentId', 'runId', 'trigger', 'model'], {
      agentId: str, runId: str, trigger: { enum: ['directive', 'schedule', 'event'] }, model: str
    }),
    'agent.reasoning': obj(['agentId', 'runId', 'on'], { agentId: str, runId: str, on: bool }),
    'agent.token': obj(['agentId', 'runId', 'delta'], { agentId: str, runId: str, delta: str }),
    'agent.tool_call': obj(['agentId', 'runId', 'callId', 'name'], {
      agentId: str, runId: str, callId: str, name: str, argsSummary: str
    }),
    'agent.tool_result': obj(['agentId', 'runId', 'callId', 'ok', 'isError'], {
      agentId: str, runId: str, callId: str, ok: bool, ms: num, summary: str, isError: bool
    }),
    // L2: a non-Anthropic model's mechanically-broken tool-call args were repaired into valid JSON before use.
    'tool.args.repaired': obj(['agentId', 'runId', 'callId', 'name'], {
      agentId: str, runId: str, callId: str, name: str, before: str, after: str
    }),
    'cost.estimate': obj(['agentId', 'runId', 'usd', 'tokens'], { agentId: str, runId: str, usd: num, tokens: int }),
    'agent.cost': obj(['agentId', 'runId', 'usd', 'reconciled'], {
      agentId: str, runId: str, usd: num, tokensIn: int, tokensOut: int,
      reasoningTokens: int, cachedTokens: int, model: str, reconciled: { enum: [true] }
    }),
    'agent.run.end': obj(['agentId', 'runId', 'reason', 'turns', 'usd'], {
      agentId: str, runId: str,
      reason: { enum: ['done', 'max_iters', 'budget', 'cancelled', 'error', 'refusal'] },
      turns: int, usd: num,
      // ADDITIVE (optional, Lane 5): WHY the provider stopped when it was a truncation/policy cut. Present ONLY
      // for the non-clean stops so the frontend can render a "cut short" recap instead of a delivered crate; a
      // clean run omits it entirely (old payloads stay valid — not required, no additionalProperties:false).
      finishReason: { enum: ['length', 'content_filter'] }
    }),
    'agent.run.error': obj(['agentId', 'runId', 'message', 'transient'], {
      agentId: str, runId: str, message: str, transient: bool
    }),
    // the loop advanced its failover chain mid-run: a fallback to an alternate model and/or a credential
    // rotation (P0.2/P3.1). Observable telemetry — the only prior signal was the switched agent.cost.model.
    'provider.fallback': obj(['agentId', 'runId', 'fromModel', 'toModel', 'reason'], {
      agentId: str, runId: str, fromModel: str, toModel: str, reason: str,
      fromProvider: str, toProvider: str, rotate: bool
    }),
    // a no-op turn (no tool call + no NEW assistant content — an empty stream or a re-emitted prior turn, e.g. a
    // wasted failover/compaction retry) was REFUNDED from the iteration budget instead of counting against maxIters.
    // Bounded by a per-run floor (refundsUsed) so a pathological all-no-op run still terminates. Observability only.
    'iteration.refunded': obj(['agentId', 'runId', 'reason'], {
      agentId: str, runId: str, turn: int, reason: { enum: ['empty', 'duplicate'] }, refundsUsed: int
    }),
    'run.cancel': obj(['runId'], { runId: str }),
    // context was compacted mid-run (Hermes-style cache-aware compaction): tokens before/after + items removed.
    'agent.compact': obj(['agentId', 'runId'], {
      agentId: str, runId: str, beforeTokens: int, afterTokens: int, removed: int, reason: str
    }),

    // ---- memory / context (Cortex) ----
    // a recalled-memory fence was injected into this run's prompt (count = records included; chars = fence size).
    'memory.recall': obj(['agentId', 'runId', 'count'], { agentId: str, runId: str, count: int, chars: int }),
    // a memory record was committed — after the user approved a proposal, or via notebook.write. scope/streamId optional.
    'memory.write': obj(['agentId', 'runId', 'id', 'kind'], { agentId: str, runId: str, id: str, kind: str, scope: str, streamId: str }),
    // a memory record was removed — user pressed forget, or a proposal was discarded.
    'memory.forget': obj(['agentId', 'id'], { agentId: str, id: str, reason: str }),
    // reflection PROPOSED a record for Keep/Edit/Discard turn-in (not yet committed). scope/streamId optional.
    'memory.proposed': obj(['agentId', 'runId', 'id', 'kind'], { agentId: str, runId: str, id: str, kind: str, scope: str, streamId: str }),
    // a stored record was actually surfaced into a prompt this run — drives useCount/trust (one per included id).
    'memory.used': obj(['agentId', 'runId', 'id'], { agentId: str, runId: str, id: str }),
    // a signed trust adjustment for a record (Keep/Edit/Discard, pin, forget) — folded into computed trust.
    'memory.feedback': obj(['agentId', 'id', 'delta'], { agentId: str, id: str, delta: num, reason: str }),

    // ---- capability / permission ----
    'capdenied': obj(['agentId', 'need', 'reason'], { agentId: str, need: str, reason: str }),
    'permission.prompt': obj(['promptId', 'agentId', 'tool', 'scope'], {
      promptId: str, agentId: str, tool: str, scope: str, argsSummary: str
    }),
    // a backend->frontend COMMAND (mirrors permission.prompt): the orchestrator's team.summon tool asks the
    // LIVE station to create a new worker agent — the SAME action the Commander takes in the Recruitment Bay.
    // The browser runs the real summonAgent() and POSTs /api/summon/ack with the new agentId, resolving the
    // tool. agentId = the requesting LEAD (attribution); the new agent's id comes back on the ack, not here.
    'crew.summon.request': obj(['requestId', 'agentId'], {
      requestId: str, agentId: str, name: str, specId: str, persona: str, skin: str, purpose: str
    }),
    'permission.response': obj(['promptId', 'decision'], {
      promptId: str, decision: { enum: ['once', 'session', 'always', 'deny', 'full'] }
    }),
    'object.place': obj(['room', 'objectType', 'instanceId'], { room: str, objectType: str, instanceId: str }),
    'object.reclaim': obj(['room', 'objectType', 'instanceId'], { room: str, objectType: str, instanceId: str }),
    'budget.threshold': obj(['scope', 'usd', 'cap'], { scope: { enum: ['run', 'day', 'global'] }, usd: num, cap: num }),

    // ---- cron / scheduled routines (autonomous, unattended fires; producers in the index.js tick driver) ----
    // the scheduler tick ran: how many due jobs it planned / fired / skipped this pass (the war-room pulse).
    'cron.tick': obj(['fired', 'skipped'], { fired: int, skipped: int, planned: int }),
    // a scheduled job fired a run — runId links to the agent.* run it launched; scheduledFor = ms it was due.
    'cron.fire': obj(['jobId', 'runId'], { jobId: str, runId: str, scheduledFor: num }),
    // a due job was NOT fired this tick (already running, disabled, stale-fast-forwarded, ungated, lease-reclaimed).
    'cron.skipped': obj(['jobId', 'reason'], {
      jobId: str, reason: { enum: ['already-running', 'disabled', 'caught-up', 'no-capability', 'stale-lock-reclaimed'] }
    }),
    // a fired job's run finished: ok / failed (always delivered) / silent ([SILENT] suppressed delivery, audit kept).
    'cron.result': obj(['jobId', 'runId', 'outcome'], {
      jobId: str, runId: str, outcome: { enum: ['ok', 'failed', 'silent'] }, reason: str
    }),

    // ---- away workshop (an agent builds a reviewable deliverable in its own jail while the Commander is away) ----
    // a workshop shift completed with a VALIDATED manifest (files proven to exist on disk). manifest is the
    // deliverable.json body (see docs/AWAY_WORKSHOP_PLAN.md §4) — carried as an opaque object so a manifest-schema
    // bump never re-freezes the bus contract. Emitted ONLY after validation; an invalid/missing manifest emits nothing.
    'workshop.built': obj(['agentId', 'runId', 'manifest'], { agentId: str, runId: str, manifest: any }),
    // the Commander decided a pending deliverable: keep (copied out to destPath under normal interactive consent),
    // discard (run dir wiped + backlogId denylisted so it isn't silently retried), or later (dismissed only).
    'workshop.decided': obj(['agentId', 'runId', 'decision'], {
      agentId: str, runId: str, decision: { enum: ['keep', 'discard', 'later'] }, destPath: str
    }),

    // ---- execution spine: checkpoints · shell · verification (producers in the exec-spine modules) ----
    // a shadow-git workspace snapshot was taken before a mutating turn (the rollback net). files/bytes = snapshot size.
    'checkpoint.created': obj(['agentId', 'runId', 'turn', 'snapshotId'], {
      agentId: str, runId: str, turn: int, snapshotId: str, files: int, bytes: int, label: str
    }),
    // the workspace was rolled back to a prior snapshot (manual rewind or a policy auto-restore).
    'checkpoint.restored': obj(['agentId', 'runId', 'toSnapshotId'], {
      agentId: str, runId: str, toSnapshotId: str, reason: str
    }),
    // a shell command ran (gated by consent + an auto-checkpoint). cmdSummary is redacted; cwd is the jail root.
    'shell.exec': obj(['agentId', 'runId', 'callId', 'exitCode'], {
      agentId: str, runId: str, callId: str, cmdSummary: str, cwd: str, exitCode: int, ms: num, truncated: bool
    }),
    // H2.2: a background/long-running shell process (shell.exec background:true) ended — fires AFTER the
    // originating run's stream closed, so it rides the durable SSE bus (chanEmit), not the per-run NDJSON.
    'shell.bg.exit': obj(['agentId', 'bgId', 'exitCode'], {
      agentId: str, bgId: str, exitCode: int, ms: num, killed: bool
    }),
    // post-edit verification: the project's own check, or an LSP lint-DELTA (only NEWLY-introduced diagnostics).
    'verify.result': obj(['agentId', 'runId', 'passed'], {
      agentId: str, runId: str, tool: str, passed: bool, added: int, removed: int, summary: str
    }),

    // ---- messaging-channel ingress (Telegram/Discord adapters; producers wired in C5) ----
    // a message arrived on a platform, was admitted, and was mapped to an agent (the trigger-source telemetry
    // that agent.run.start.trigger only labels). channel/chatId/userId are not secrets; the bot token never appears.
    'channel.inbound': obj(['channel', 'chatId', 'agentId'], {
      channel: str, chatId: str, agentId: str, userId: str, kind: { enum: ['dm', 'group'] }
    }),
    // the agent's reply was delivered back to the platform (chunk count + ok/why) — outbound delivery telemetry.
    'channel.delivery': obj(['channel', 'chatId', 'runId', 'ok'], {
      channel: str, chatId: str, runId: str, ok: bool, chunks: int, reason: str
    }),
    // adapter transport health: poll up / network down / fatal token error (in-memory health state).
    'channel.connect': obj(['channel', 'state'], {
      channel: str, state: { enum: ['up', 'down', 'error'] }, detail: str
    }),

    // ---- logistics / work-item conveyor (boxes that carry REAL work along player-laid belts) ----
    // a real inbound work-item (e.g. an admitted Telegram message) was queued at a SOURCE — the start of
    // the belt journey. preview is a short, already-redacted text snippet; queueDepth is the per-agent backlog.
    'workitem.placed': obj(['workitemId', 'queueId'], {
      workitemId: str, queueId: str, agentId: str, kind: str, preview: str, queueDepth: int, ts: num
    }),
    // a work-item rode into a bay/sink and its payload was consumed (run-start for inbound; reply/file/memory
    // for outbound). box is an optional short JSON-string summary, not a deep object (keeps validation cheap).
    'workitem.delivered': obj(['workitemId', 'finalQueueId'], {
      workitemId: str, finalQueueId: str, agentId: str, box: str, ms: num, ts: num
    }),
    // a newer message for the same chat ABORTED this work-item's run (hub supersede) — its box should drop
    // off the belt instead of riding to the desk. Mirrors the hub's one-run-per-chat inflight behavior.
    'workitem.superseded': obj(['workitemId'], { workitemId: str, agentId: str, ts: num }),
    // queue-depth telemetry for the backpressure HUD — emitted whenever a per-agent queue depth changes.
    'queue.status': obj(['queueId'], { queueId: str, depth: int, maxCapacity: int, nextAdvanceAt: num }),

    // ---- reserved (P3 mutation API) ----
    'worldChange': obj(['seq'], { seq: int, dirtyTiles: { type: 'array' } }),

    // ---- reused v7 names (re-emitted from REAL transitions; frontend listeners fire unchanged) ----
    'task': obj(['id', 'status'], {
      id: str, agentId: str, status: { enum: ['queued', 'running', 'done', 'failed', 'todo'] }, kind: str, title: str
    }),
    'chat': obj(['from', 'txt'], { from: str, txt: str }),
    'deliverable': obj(['id'], { id: str, agentId: str, room: str, kind: str, title: str }),
    'notify': str,                                  // payload is a bare string
    'stats': any, 'level': any, 'objectives': any,  // listeners read a snapshot the telemetry layer maintains

    // ---- retired (kept VALID/known, emitted only as optional cosmetics off real completions) ----
    'sale': any, 'parcel': any, 'intel': any, 'flagged': any, 'hazard': any, 'party': any, 'day': any
  };

  function deepFreeze(o) {
    Object.freeze(o);
    for (const k in o) { const v = o[k]; if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v); }
    return o;
  }
  deepFreeze(EVENTS);

  function isKnown(name) { return Object.prototype.hasOwnProperty.call(EVENTS, name); }
  function names() { return Object.keys(EVENTS); }
  function validate(name, payload) {
    if (!isKnown(name)) return { ok: false, errors: ['unknown event: ' + name] };
    return schema.validate(EVENTS[name], payload);
  }

  return { EVENTS, SCHEMA_VERSION, validate, isKnown, names };
});
