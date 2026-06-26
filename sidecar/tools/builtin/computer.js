/* sidecar/tools/builtin/computer.js - desktop computer-use tool.
   The real OS driver is injected by the desktop shell. This module owns the
   harness contract: action enum, consent/execute scope, destructive input
   hard-blocks, and capture_after proof.

   makeComputerTools({ driver? }) -> { useTool, register(reg), _internals }
     driver.perform(action) -> Promise
     driver.capture()       -> Promise<{ width, height, ... } | string>
*/
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.tools = root.SK.tools || {}; (root.SK.tools.builtin = root.SK.tools.builtin || {}).computer = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ACTIONS = ['screenshot', 'move', 'click', 'double_click', 'drag', 'scroll', 'type', 'key', 'hotkey', 'wait'];
  const DESTRUCTIVE_HOTKEYS = [
    'ctrl+alt+delete',
    'ctrl+shift+esc',
    'alt+f4',
    'meta+r',
    'win+r',
    'meta+x',
    'win+x',
    'ctrl+w',
    'ctrl+q'
  ];
  const COMMAND_TEXT_RE = /\b(cmd|powershell|pwsh|bash|sh)\s+(\/c|-c)\b|(^|\s)(rm\s+-rf|del\s+\/[sq]|format\s+[a-z]:|shutdown\b|restart-computer\b|reg\s+delete\b|curl\s+.*\|\s*(sh|bash|pwsh|powershell))/i;

  function normKey(s) {
    return String(s || '').toLowerCase().replace(/\s+/g, '').replace(/windows/g, 'win').replace(/command/g, 'meta');
  }
  function validateAction(raw) {
    const a = Object.assign({}, raw || {});
    a.action = String(a.action || '').trim();
    if (ACTIONS.indexOf(a.action) < 0) throw new Error('unsupported computer action: ' + a.action);
    if (a.x != null) a.x = Number(a.x);
    if (a.y != null) a.y = Number(a.y);
    if (a.dx != null) a.dx = Number(a.dx);
    if (a.dy != null) a.dy = Number(a.dy);
    if (a.durationMs != null) a.durationMs = Math.max(0, Math.min(10000, Number(a.durationMs) || 0));
    if (a.button != null) a.button = String(a.button);
    if (a.text != null) a.text = String(a.text);
    if (a.key != null) a.key = String(a.key);
    if (a.keys != null && !Array.isArray(a.keys)) throw new Error('computer hotkey keys must be an array');
    if (Array.isArray(a.keys)) a.keys = a.keys.map(k => String(k));
    return a;
  }
  function hardBlock(action) {
    const a = validateAction(action);
    if (a.action === 'type' && COMMAND_TEXT_RE.test(a.text || '')) {
      throw new Error('blocked command-like desktop typing pattern');
    }
    if (a.action === 'hotkey') {
      const combo = normKey((a.keys || []).join('+') || a.key);
      if (DESTRUCTIVE_HOTKEYS.indexOf(combo) >= 0) throw new Error('blocked destructive desktop hotkey: ' + combo);
    }
    if (a.action === 'key') {
      const key = normKey(a.key);
      if (DESTRUCTIVE_HOTKEYS.indexOf(key) >= 0) throw new Error('blocked destructive desktop key: ' + key);
    }
    return a;
  }
  function summarize(action) {
    const a = action || {};
    if (a.action === 'type') return 'type ' + String(a.text || '').length + ' chars';
    if (a.action === 'hotkey') return 'hotkey ' + ((a.keys || []).join('+') || a.key || '');
    if (a.action === 'click' || a.action === 'double_click' || a.action === 'move') return a.action + ' ' + a.x + ',' + a.y;
    if (a.action === 'drag') return 'drag ' + a.x + ',' + a.y + ' by ' + (a.dx || 0) + ',' + (a.dy || 0);
    if (a.action === 'scroll') return 'scroll ' + (a.dx || 0) + ',' + (a.dy || 0);
    return a.action;
  }
  function makeDriver(deps) {
    const d = deps && deps.driver;
    if (d && typeof d.perform === 'function') return d;
    return {
      perform: async () => { throw new Error('computer-use unavailable: no desktop driver configured'); },
      capture: async () => { throw new Error('computer-use unavailable: no desktop capture driver configured'); }
    };
  }

  function makeComputerTools(deps) {
    deps = deps || {};
    const driver = makeDriver(deps);
    const useTool = {
      name: 'computer.use',
      capability: 'workbench',
      scope: 'execute',
      requiresConsent: true,
      timeoutMs: 15000,
      description: 'Control the local desktop through an attended, consent-gated computer-use driver. Supports screenshot, move, click, double_click, drag, scroll, type, key, hotkey, and wait. Destructive shortcuts and command-like typing are blocked.',
      schema: {
        type: 'object',
        required: ['action'],
        properties: {
          action: { type: 'string', enum: ACTIONS },
          x: { type: 'number' },
          y: { type: 'number' },
          dx: { type: 'number' },
          dy: { type: 'number' },
          button: { type: 'string' },
          text: { type: 'string' },
          key: { type: 'string' },
          keys: { type: 'array', items: { type: 'string' } },
          durationMs: { type: 'number' },
          capture_after: { type: 'boolean' }
        }
      },
      run: async (args, ctx) => {
        const action = hardBlock(args || {});
        const result = await driver.perform(action);
        let proof = '';
        if (action.capture_after || action.action === 'screenshot') {
          const cap = await driver.capture();
          if (!cap) throw new Error('capture_after failed: no capture returned');
          if (typeof cap === 'string') proof = 'capture_after=' + cap;
          else proof = 'capture_after=' + JSON.stringify(cap);
        }
        const content = 'computer.' + action.action + ' ok' + (proof ? '\n' + proof : '') + (result ? '\n' + String(result) : '');
        return { content, summary: summarize(action) };
      }
    };
    return { useTool, register(reg) { reg.register(useTool); return reg; }, _internals: { ACTIONS, hardBlock, validateAction, summarize, COMMAND_TEXT_RE } };
  }

  return { makeComputerTools, _internals: { ACTIONS, hardBlock, validateAction, summarize, COMMAND_TEXT_RE } };
});
