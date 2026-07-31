'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const index = fs.readFileSync(path.join(root, 'frontend', 'index.html'), 'utf8');
const source = fs.readFileSync(path.join(root, 'frontend', 'app', 'voice-live.js'), 'utf8');
const voiceSource = fs.readFileSync(path.join(root, 'frontend', 'app', 'voice.js'), 'utf8');
const chatSource = fs.readFileSync(path.join(root, 'frontend', 'app', 'chat.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'frontend', 'css', 'app.css'), 'utf8');

assert.doesNotMatch(index, /id="voice-mode"/, 'legacy hands-free button is removed from COMMS');
assert.equal((index.match(/id="voice-live"/g) || []).length, 1, 'Local Live is the one hands-free control');
assert.match(index, /aria-label="Start Local Live hands-free voice"/, 'the canonical hands-free control has an explicit accessible name');
assert.match(source, /document\.body\.appendChild\(panel\)/, 'live controller is app-global, not mounted inside COMMS');
assert.doesNotMatch(source, /insertBefore\(panel,\s*chatLog\)/, 'live controller must not consume transcript space');
assert.match(source, /button\.onclick\s*=\s*\(\)\s*=>\s*active\s*\?\s*end\(\)\s*:\s*start\(false\)/, 'live button toggles the session off');
assert.match(source, /addEventListener\('pointermove'/, 'floating controller supports pointer dragging');
assert.match(source, /POSITION_KEY/, 'floating position is remembered');
assert.match(source, /seq\s*!==\s*sessionSeq/, 'late microphone permission cannot resurrect a closed session');
assert.match(source, /requestPartial\(utterance,\s*utteranceSeq\)/, 'long turns surface local partial transcription');
assert.match(source, /function endpointSilenceMs\(durationMs,\s*text\)/, 'turn endpointing has a dedicated hesitation-aware policy');
assert.match(source, /durationMs\s*<\s*1200\s*\?\s*1350\s*:\s*durationMs\s*<\s*3200\s*\?\s*1150\s*:\s*950/, 'thinking pauses receive at least 950–1350ms before submission');
assert.match(source, /Math\.min\(1750,\s*wait\s*\+\s*450\)/, 'incomplete partial transcripts receive an additional hesitation grace period');
assert.match(source, /partialText\s*=\s*text/, 'semantic pause handling is grounded in the real partial transcript');
assert.doesNotMatch(source, /durationMs\s*<\s*900\s*\?\s*850/, 'the former aggressive sub-second endpoint policy is removed');
assert.match(source, /scheduleReconnect\(/, 'lost microphones enter the reconnect state machine');
assert.match(source, /approvalCommand\(lower\)/, 'run-scoped approvals can be answered by an explicit voice command');
assert.match(source, /agentCommand\(value,\s*lower\)/, 'voice can select the active Starnet agent without provider coupling');
assert.match(source, /Harness\.getProv/, 'the controller reports the active Starnet provider');
assert.doesNotMatch(source, /CODEX OAUTH/, 'provider-agnostic voice UI does not claim Codex is required');
assert.match(source, /attachCoordinator\(\{\s*onState,\s*onAssistant,\s*onOutputLevel\s*\}\)/, 'live controller subscribes to real agent output levels');
assert.match(source, /bar\.dataset\.src\s*=\s*cell\.src/, 'wave history preserves which side of the conversation produced each sample');
assert.match(source, /setAttribute\('aria-busy'/, 'working voice states are exposed to assistive technology');
assert.match(source, /Agent speaking — press to interrupt and speak/, 'barge-in control names the active agent-speaking state');
assert.match(source, /Stop Local Live hands-free voice/, 'active Local Live button truthfully advertises its stop action');
assert.match(source, /Voice\.inVoiceMode\(\)[\s\S]*?Voice\.stopConvo\(\)/, 'Local Live closes any legacy hands-free loop before opening');
assert.match(chatSource, /VoiceLive\.start\(false\)/, '/voice live opens the canonical Local Live system');
assert.match(chatSource, /Local Live voice stopped\./, '/voice live toggles the canonical system off');
assert.doesNotMatch(chatSource, /Hands-free voice mode toggled\./, 'slash command no longer activates the legacy hands-free loop');
assert.match(voiceSource, /const endFailed\s*=\s*\(\)\s*=>[\s\S]*?onSpeakEnd\(\)[\s\S]*?onFail/, 'media failures clear speaking and meter state before the queue advances');
assert.match(voiceSource, /currentAudioCleanup/, 'interrupted blob playback has an explicit URL cleanup path');
assert.match(css, /\.live-voice-panel\s*\{[^}]*position:\s*fixed/s, 'controller follows the user across StarNet views');
assert.match(css, /\.lv-head\s*\{[^}]*cursor:\s*grab/s, 'header advertises the drag affordance');
assert.match(css, /\.lv-wave i\[data-src="self"\]/, 'the user side of the shared waveform has an explicit visual contract');
assert.match(css, /\.lv-wave i\[data-src="agent"\]/, 'the agent side of the shared waveform has an explicit visual contract');
assert.match(css, /@media \(hover: none\), \(pointer: coarse\)[\s\S]*?\.lv-x\s*\{[^}]*pointer-events:\s*auto/, 'touch users always have a reachable close control');

/* ⛔ LIVE VOICE OPENS AUDIBLE ON *BOTH* PATHS. Local Live has two entry points: start() when the offline
   speech models are present (a source checkout) and startDictation() when they are not — which is EVERY
   packaged build, because the installer ships no node_modules. Wiring the speaker auto-enable into start()
   alone therefore fixed it only where nobody ships from: installed stations still opened muted, so the
   Commander talked and heard nothing. Assert it per-function, not file-wide: a file-wide match would have
   passed happily while the path that actually runs was missing it. */
function bodyOf(name) {
  const m = new RegExp('function ' + name + '\\([\\s\\S]*?\\n  \\}').exec(source);
  assert.ok(m, 'voice-live.js still defines ' + name + '()');
  return m[0];
}
for (const fn of ['start', 'startDictation']) {
  assert.match(bodyOf(fn), /Voice\.forceSpeakOn\(\)/, fn + '() force-enables the speaker — hands-free is never opened muted');
  /* ⛔ BOTH entry points speak with the BUILT-IN identity. setLocalTts(true) is what routes /api/tts through
     the picked voice; the dictation leg passing false is what let the keyed provider voice speak on every
     installed build while the picker adjusted an engine that was not there (the identity bug Andrew heard).
     The sidecar maps the pick onto the Edge floor when the offline engine is absent, so true is correct on
     the shipped path too. */
  assert.match(bodyOf(fn), /Voice\.setLocalTts\(true\)/, fn + '() opts into the built-in voice identity');
}
// (start()'s failure teardown legitimately resets the flag — only a reset on the HAPPY path would be the bug,
// and the positive per-function assert above is what locks that.)
assert.match(bodyOf('finish'), /Voice\.restoreSpeak\(\)/, 'leaving restores a mute we lifted (a hand-set speaker is left alone)');
assert.match(bodyOf('finish'), /Voice\.setLocalTts\(false\)/, 'leaving live voice returns ordinary speech to the persona ladder');

/* ⛔ THE CALL IS BOUND TO ONE SESSION. Everything routed through Chat lands on the ACTIVE workstream, so
   without a binding, browsing the rail mid-call silently re-targeted the conversation — the next utterance
   ran in whatever session was open, under that session's agent (Andrew hit this live). Both entry points
   bind; every utterance pins focus back to the bound session; the binding dies with the call; and the ONE
   legitimate rebind is a voice-driven station.switch_session while a call is live. */
for (const fn of ['start', 'startDictation']) {
  assert.match(bodyOf(fn), /bindSession\(\)/, fn + '() binds the call to the session it was opened in');
}
assert.match(bodyOf('handleTranscript'), /ensureBoundFocus\(\)/, 'every utterance routes to the BOUND session, not whatever is focused');
assert.match(bodyOf('finish'), /boundWsId = null/, 'the binding dies with the call');
assert.match(source, /boundSession\(\) \|\| Workstreams\.active\(\)/, "the panel reports the CALL's session, not the browsed one");
const cmdSource = fs.readFileSync(path.join(root, 'frontend', 'app', 'stationcommands.js'), 'utf8');
assert.match(cmdSource, /VoiceLive\.isActive\(\) && VoiceLive\.rebind/, 'a voice-driven session switch rebinds the live call (a UI click never routes through that verb)');
assert.match(voiceSource, /if \(!forcedSpeak\) return false;/, "restoreSpeak never undoes the Commander's own speaker choice");

console.log('voice-live-ui.test.js: ok');
