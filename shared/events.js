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
      turns: int, usd: num
    }),
    'agent.run.error': obj(['agentId', 'runId', 'message', 'transient'], {
      agentId: str, runId: str, message: str, transient: bool
    }),
    'run.cancel': obj(['runId'], { runId: str }),

    // ---- memory / context (Cortex) ----
    // a recalled-memory fence was injected into this run's prompt (count = records included; chars = fence size).
    'memory.recall': obj(['agentId', 'runId', 'count'], { agentId: str, runId: str, count: int, chars: int }),
    // a memory record was committed — after the user approved a proposal, or via notebook.write. scope optional.
    'memory.write': obj(['agentId', 'runId', 'id', 'kind'], { agentId: str, runId: str, id: str, kind: str, scope: str }),
    // a memory record was removed — user pressed forget, or a proposal was discarded.
    'memory.forget': obj(['agentId', 'id'], { agentId: str, id: str, reason: str }),

    // ---- capability / permission ----
    'capdenied': obj(['agentId', 'need', 'reason'], { agentId: str, need: str, reason: str }),
    'permission.prompt': obj(['promptId', 'agentId', 'tool', 'scope'], {
      promptId: str, agentId: str, tool: str, scope: str, argsSummary: str
    }),
    'permission.response': obj(['promptId', 'decision'], {
      promptId: str, decision: { enum: ['once', 'session', 'always', 'deny'] }
    }),
    'object.place': obj(['room', 'objectType', 'instanceId'], { room: str, objectType: str, instanceId: str }),
    'object.reclaim': obj(['room', 'objectType', 'instanceId'], { room: str, objectType: str, instanceId: str }),
    'budget.threshold': obj(['scope', 'usd', 'cap'], { scope: { enum: ['run', 'day', 'global'] }, usd: num, cap: num }),

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
