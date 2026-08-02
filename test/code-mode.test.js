/* node test/code-mode.test.js — code.run child isolation + bounded programmatic composition. */
'use strict';
const A = require('./_assert.js');
const Code = require('../sidecar/tools/builtin/code.js');

async function expectReject(p, pattern, label) {
  let error = null;
  try { await p; } catch (e) { error = e; }
  A.ok(error && pattern.test(String(error.message || error)), label);
}

(async () => {
  // Real child process: loop/filter/branch/aggregate. Intermediate records stay inside the child;
  // only the final reduced value becomes code.run's content.
  {
    const calls = [];
    const t = Code.makeCodeTools({ limits: { timeoutMs: 3000 } }).codeTool;
    const out = await t.run({ code: `
      const ids = [1,2,3,4];
      const rows = [];
      for (const id of ids) rows.push(await tool('records.get', { id }));
      const kept = rows.filter(row => row.score >= 6);
      if (kept.length < 2) return { status: 'too-few' };
      return { status: 'ok', ids: kept.map(row => row.id), total: kept.reduce((n,row) => n + row.score, 0) };
    ` }, { callId: 'outer', composeDispatch: async req => { calls.push(req); return { id: req.args.id, score: req.args.id * 3 }; } });
    A.eq(out.content, JSON.stringify({ status: 'ok', ids: [2,3,4], total: 27 }), 'loop/filter/branch/aggregation returns only its final value');
    A.eq(calls.length, 4, 'all four nested reads crossed the parent callback');
    A.eq(out.summary, 'code composed 4 read calls', 'summary truthfully counts parent-dispatched reads');
  }

  // The vm has no ambient Node authority and the fork gets a deliberately tiny environment.
  {
    process.env.STARNET_CODE_SECRET_TEST = 'must-not-cross';
    const t = Code.makeCodeTools({ limits: { timeoutMs: 3000 } }).codeTool;
    const out = await t.run({ code: `return { process: typeof process, require: typeof require, secret: typeof STARNET_CODE_SECRET_TEST };` }, { composeDispatch: async () => '' });
    A.eq(out.content, JSON.stringify({ process: 'undefined', require: 'undefined', secret: 'undefined' }), 'process, require, and parent env secrets are absent');
    delete process.env.STARNET_CODE_SECRET_TEST;
    await expectReject(t.run({ code: `return ({}).constructor.constructor('return process')();` }, { composeDispatch: async () => '' }), /code generation.*disallowed/i, 'Function-constructor escape is blocked');
    const injected = await t.run({ code: `return { toolCtor: typeof tool.constructor, printCtor: typeof console.log.constructor };` }, { composeDispatch: async () => '' });
    A.eq(injected.content, JSON.stringify({ toolCtor: 'undefined', printCtor: 'undefined' }), 'injected host callbacks expose no host Function constructor');
  }

  // Parent denial remains authoritative and is catchable as a normal script error.
  {
    const t = Code.makeCodeTools({ limits: { timeoutMs: 3000 } }).codeTool;
    const out = await t.run({ code: `try { await tool('fs.write', {path:'x',content:'y'}); } catch (e) { return e.message; }` }, {
      composeDispatch: async () => { throw new Error('code.run v1 may compose only consent-free read tools; refused fs.write'); }
    });
    A.ok(/refused fs\.write/.test(out.content), 'a denied nested mutation reaches the program as an error, never executes');
  }

  // Host policy rejects recursion, team fan-out, mutations, connectors, and withheld reads before dispatch.
  {
    const R = Code._internals.refusalForNested;
    const granted = new Set(['code.run', 'fs.read', 'fs.write', 'team.spawn', 'mcp.read']);
    A.ok(/recursive/.test(R('code.run', { scope: 'read' }, granted)), 'recursive code.run denied');
    A.ok(/team/.test(R('team.spawn', { scope: 'read' }, granted)), 'team spawning denied');
    A.ok(/consent-free read/.test(R('fs.write', { scope: 'write', requiresConsent: true }, granted)), 'mutations denied before journal/dispatch');
    A.ok(/connector/.test(R('mcp.read', { scope: 'read', capability: 'mcp:x' }, granted)), 'connector ambiguity denied in v1');
    A.ok(/WITHHELD/.test(R('fs.search', { scope: 'read' }, granted)), 'a registered but ungranted read stays withheld');
    A.eq(R('fs.read', { scope: 'read', requiresConsent: false }, granted), '', 'a granted consent-free read is admitted');
  }

  // Output, nested-call count, wall time and cancellation are independently bounded.
  {
    const capped = Code.makeCodeTools({ limits: { timeoutMs: 3000, maxCalls: 2, maxOutputBytes: 64 } }).codeTool;
    const out = await capped.run({ code: `return 'x'.repeat(200);` }, { composeDispatch: async () => 'x' });
    A.ok(/truncated at 64 bytes/.test(out.content), 'final output cap is explicit');
    A.ok(Buffer.byteLength(out.content, 'utf8') <= 64, 'final output including its notice stays within the byte cap');
    const callCapped = Code.makeCodeTools({ limits: { timeoutMs: 3000, maxCalls: 2, maxOutputBytes: 1000 } }).codeTool;
    const calls = await callCapped.run({ code: `
      let denied='';
      for (let i=0;i<3;i++) try { await tool('x', {i}); } catch(e) { denied=e.message; }
      return denied;
    ` }, { composeDispatch: async () => 'ok' });
    A.ok(/call limit exceeded/.test(calls.content), 'nested call cap refuses excess calls');

    const timed = Code.makeCodeTools({ limits: { timeoutMs: 100 } }).codeTool;
    await expectReject(timed.run({ code: 'while (true) {}' }, { composeDispatch: async () => '' }), /timed out/, 'CPU loop is killed by the parent deadline');

    const ctrl = new AbortController();
    const cancelling = Code.makeCodeTools({ limits: { timeoutMs: 3000 } }).codeTool.run(
      { code: `while (true) {}` },
      { signal: ctrl.signal, composeDispatch: async () => '' }
    );
    setTimeout(() => ctrl.abort(), 30);
    await expectReject(cancelling, /cancelled/, 'run cancellation kills the isolated worker');
  }

  // Public shape: this is a computer-granted READ composition tool, never a disguised shell.
  {
    const t = Code.makeCodeTools({}).codeTool;
    A.eq(t.name, 'code.run', 'stable public name');
    A.eq(t.scope, 'read', 'v1 carries read scope');
    A.eq(t.requiresConsent, false, 'the primitive itself has no side effect to consent to');
    A.ok(/currently granted READ tools/.test(t.description), 'wire description states the authority boundary');
  }

  A.report('code-mode.test');
})().catch(e => { console.error(e); process.exit(1); });
