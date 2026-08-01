/* Isolated child for code.run. This process has no tool implementations or credentials.
 * The only authority crossing the IPC boundary is a bounded `tool(name,args)` request;
 * the parent re-validates and dispatches every request through the ordinary run gates. */
'use strict';

const vm = require('node:vm');

const pending = new Map();
let nextId = 1;

function serializable(value) {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value));
}

function tool(name, args) {
  return new Promise((resolve, reject) => {
    const id = String(nextId++);
    pending.set(id, { resolve, reject });
    if (typeof process.send !== 'function') return reject(new Error('code-mode IPC unavailable'));
    process.send({ type: 'tool', id, name: String(name || ''), args: serializable(args || {}) });
  });
}

// A host-realm function injected into node:vm can otherwise expose its Function constructor.
// Removing the prototype makes `tool.constructor(...)` / `print.constructor(...)` unavailable;
// codeGeneration.strings=false separately closes constructors belonging to context-created values.
Object.setPrototypeOf(tool, null);
Object.freeze(tool);

process.on('message', async (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'tool_result') {
    const p = pending.get(String(msg.id));
    if (!p) return;
    pending.delete(String(msg.id));
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(String(msg.error || 'nested tool failed')));
    return;
  }
  if (msg.type !== 'run') return;

  const printed = [];
  const print = (...values) => {
    printed.push(values.map(v => typeof v === 'string' ? v : JSON.stringify(v)).join(' '));
  };
  Object.setPrototypeOf(print, null);
  Object.freeze(print);
  try {
    const sandbox = Object.create(null);
    const consoleView = Object.create(null);
    Object.assign(consoleView, { log: print, info: print, warn: print, error: print });
    Object.freeze(consoleView);
    Object.assign(sandbox, { tool, print, console: consoleView });
    sandbox.globalThis = sandbox;
    const context = vm.createContext(sandbox, {
      name: 'starnet-code-mode',
      codeGeneration: { strings: false, wasm: false }
    });
    const wrapped = '(async () => {\n"use strict";\n' + String(msg.code || '') + '\n})()';
    const script = new vm.Script(wrapped, { filename: 'model-code.js' });
    const value = await script.runInContext(context, { timeout: Number(msg.syncTimeoutMs) || 1000 });
    const result = value === undefined ? printed.join('\n') : value;
    if (typeof process.send === 'function') process.send({ type: 'done', result: serializable(result), printed });
  } catch (e) {
    if (typeof process.send === 'function') process.send({ type: 'error', error: String((e && e.message) || e) });
  }
});
