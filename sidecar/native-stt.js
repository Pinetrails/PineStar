'use strict';

// Windows-native offline dictation fallback for OAuth Live voice. The command is entirely static: no user
// text enters PowerShell. System.Speech listens to the default microphone after the user explicitly starts
// Live voice, returns one utterance, then disposes the recognizer.
const WINDOWS_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  'Add-Type -AssemblyName System.Speech',
  "[Console]::OutputEncoding=[Text.Encoding]::UTF8",
  '$r=New-Object System.Speech.Recognition.SpeechRecognitionEngine',
  '$r.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))',
  '$r.SetInputToDefaultAudioDevice()',
  '$x=$r.Recognize([TimeSpan]::FromSeconds(15))',
  "if($null -ne $x){Write-Output $x.Text}",
  '$r.Dispose()'
].join(';');

function makeNativeStt(opts) {
  opts = opts || {};
  const platform = opts.platform || process.platform;
  const execFile = opts.execFile;

  function status() {
    return {
      available: platform === 'win32' && typeof execFile === 'function',
      engine: platform === 'win32' ? 'windows-system-speech' : 'unsupported'
    };
  }

  function recognize(params) {
    params = params || {};
    if (!status().available) return Promise.resolve({ ok: false, text: '', error: 'native speech is unavailable on this platform' });
    return new Promise(resolve => {
      const options = {
        windowsHide: true,
        timeout: 20000,
        maxBuffer: 1 << 16,
        encoding: 'utf8'
      };
      if (params.signal) options.signal = params.signal;
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_SCRIPT], options, (error, stdout) => {
        const text = String(stdout || '').replace(/\r?\n/g, ' ').trim().slice(0, 4000);
        if (text) return resolve({ ok: true, text });
        if (error && error.name === 'AbortError') return resolve({ ok: false, text: '', error: 'aborted' });
        const timedOut = !!(error && (error.killed || error.code === 'ETIMEDOUT'));
        resolve({ ok: !error || timedOut, text: '', error: timedOut ? 'no-speech' : 'native speech failed' });
      });
    });
  }

  return { status, recognize };
}

module.exports = { WINDOWS_SCRIPT, makeNativeStt };
