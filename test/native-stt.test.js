'use strict';

const assert = require('node:assert/strict');
const { WINDOWS_SCRIPT, makeNativeStt } = require('../sidecar/native-stt.js');

(async () => {
  assert.match(WINDOWS_SCRIPT, /System\.Speech/);
  assert.equal(WINDOWS_SCRIPT.includes('$args'), false);

  const unsupported = makeNativeStt({ platform: 'linux', execFile() {} });
  assert.equal(unsupported.status().available, false);
  assert.equal((await unsupported.recognize()).ok, false);

  let call = null;
  const engine = makeNativeStt({
    platform: 'win32',
    execFile(file, args, options, callback) {
      call = { file, args, options };
      callback(null, 'hello from local speech\r\n');
    }
  });
  assert.equal(engine.status().available, true);
  const result = await engine.recognize();
  assert.deepEqual(result, { ok: true, text: 'hello from local speech' });
  assert.equal(call.file, 'powershell.exe');
  assert.equal(call.options.windowsHide, true);
  assert.ok(call.args.includes(WINDOWS_SCRIPT));

  const failed = makeNativeStt({
    platform: 'win32',
    execFile(file, args, options, callback) { callback(new Error('private OS detail'), ''); }
  });
  const failure = await failed.recognize();
  assert.deepEqual(failure, { ok: false, text: '', error: 'native speech failed' });

  console.log('native-stt.test.js: ok');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
