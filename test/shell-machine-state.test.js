/* node test/shell-machine-state.test.js — THE MACHINE IS NOT THE WORKSPACE (incident follow-up, 2026-07-12).
   Locks the shell.exec floors that keep agent builds from touching the user's machine: no shutdown/reboot,
   no killing processes it doesn't own, no persistence (scheduled tasks / Run keys / services / startup),
   no permanent config rewrites (setx/assoc/registry/firewall), no 0.0.0.0 network exposure, and headless
   browsers must --mute-audio. Just as important: the NON-trips — ordinary build/test/git commands that
   happen to contain a scary substring must stay allowed. Pure predicate, no spawning, fast gate. */
'use strict';
const A = require('./_assert.js');
const shell = require('../sidecar/tools/builtin/shell.js');
const { breaksMachineState, exposesNetwork, opensVisibleWindow } = shell;

// ---- BLOCKED: machine lifecycle ----
A.ok(breaksMachineState('shutdown /r /t 0'), 'shutdown blocked');
A.ok(breaksMachineState('shutdown -h now'), 'posix shutdown blocked');
A.ok(breaksMachineState('logoff'), 'logoff blocked');
A.ok(breaksMachineState('Restart-Computer -Force'), 'Restart-Computer cmdlet blocked');
A.ok(breaksMachineState('sudo reboot'), 'sudo reboot blocked');

// ---- BLOCKED: killing processes the agent doesn't own ----
A.ok(breaksMachineState('taskkill /im chrome.exe /f'), 'taskkill blocked');
A.ok(breaksMachineState('taskkill /pid 1234 /t /f'), 'taskkill by pid blocked');
A.ok(breaksMachineState('pkill -9 node'), 'pkill blocked');
A.ok(breaksMachineState('killall Safari'), 'killall blocked');
A.ok(breaksMachineState('Stop-Process -Name explorer'), 'Stop-Process cmdlet blocked');

// ---- BLOCKED: persistence that outlives StarNet ----
A.ok(breaksMachineState('schtasks /create /tn evil /tr calc.exe /sc onlogon'), 'schtasks create blocked');
A.ok(breaksMachineState('schtasks /change /tn x /tr y'), 'schtasks change blocked');
A.ok(breaksMachineState('reg add HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run /v x /d game.exe'), 'reg add Run key blocked');
A.ok(breaksMachineState('reg delete HKLM\\Software\\Foo /f'), 'reg delete blocked');
A.ok(breaksMachineState('type HKCU\\Software\\Foo'), 'bare registry hive reference blocked');
A.ok(breaksMachineState('sc create mysvc binPath= C:\\x.exe'), 'sc create service blocked');
A.ok(breaksMachineState('Register-ScheduledTask -TaskName x'), 'Register-ScheduledTask blocked');
A.ok(breaksMachineState('copy game.exe "%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\g.exe"'), 'Startup folder write blocked');
A.ok(breaksMachineState('cp app "shell:startup"'), 'shell:startup blocked');

// ---- BLOCKED: permanent config rewrites / disruptive system tools ----
A.ok(breaksMachineState('setx PATH C:\\broken'), 'setx blocked');
A.ok(breaksMachineState('assoc .txt=badfile'), 'assoc blocked');
A.ok(breaksMachineState('netsh advfirewall set allprofiles state off'), 'netsh blocked');
A.ok(breaksMachineState('net user hacker Pass123 /add'), 'net user blocked');
A.ok(breaksMachineState('format d:'), 'format blocked');
A.ok(breaksMachineState('diskpart /s script.txt'), 'diskpart blocked');
A.ok(breaksMachineState('vssadmin delete shadows /all'), 'vssadmin blocked');
A.ok(breaksMachineState('bcdedit /set safeboot minimal'), 'bcdedit blocked');
A.ok(breaksMachineState('Set-ExecutionPolicy Unrestricted'), 'Set-ExecutionPolicy blocked');
A.ok(breaksMachineState('defaults write com.apple.dock foo -bool true'), 'macOS defaults write blocked');
A.ok(breaksMachineState('systemctl stop firewalld'), 'systemctl blocked');
A.ok(breaksMachineState('crontab -r'), 'crontab blocked');

// ---- BLOCKED: network exposure ----
A.ok(exposesNetwork('vite --host 0.0.0.0'), '0.0.0.0 bind blocked');
A.ok(exposesNetwork('python -m http.server --bind 0.0.0.0 8000'), '0.0.0.0 python server blocked');
A.eq(exposesNetwork('vite --host 127.0.0.1'), null, 'loopback bind allowed');

// ---- BLOCKED: headless browser without --mute-audio (the phantom-audio half of the incident) ----
A.ok(opensVisibleWindow('msedge --headless=new --remote-debugging-port=9222 http://x'), 'headless browser without --mute-audio blocked');
A.eq(opensVisibleWindow('msedge --headless=new --mute-audio --remote-debugging-port=9222 http://x'), null, 'headless + --mute-audio allowed');

// ---- NON-TRIPS: ordinary build/test/git work must keep working ----
A.eq(breaksMachineState('npm run format'), null, 'npm run format not blocked');
A.eq(breaksMachineState('git log --format=%H'), null, 'git log --format not blocked');
A.eq(breaksMachineState('prettier --write src/'), null, 'prettier write not blocked');
A.eq(breaksMachineState('echo shutdown the server when done'), null, 'the WORD shutdown in echo not blocked');
A.eq(breaksMachineState('node kill-switch.js'), null, 'a file named kill-* not blocked');
A.eq(breaksMachineState('npm start'), null, 'npm start not blocked (machine floor)');
A.eq(breaksMachineState('grep -r "taskkill" docs/'), null, 'grepping for taskkill not blocked');
A.eq(breaksMachineState('cat src/registry.js'), null, 'a file named registry.js not blocked');
A.eq(breaksMachineState('node scripts/reset-db.js'), null, 'reset-db script not blocked');
A.eq(breaksMachineState('git net-fetch'), null, 'net as part of another token not blocked');
A.eq(breaksMachineState('service-worker.js'), null, 'service-worker filename not blocked');
A.eq(breaksMachineState(''), null, 'empty command not a machine trip');

// ---- BYPASS HARDENING (code-review 2026-07-12): dangerous verbs hidden behind a launcher, separator, or
//      interpreter must still be caught (command-head splitting), and false-positive rework must hold. ----
A.ok(breaksMachineState('powershell -Command "shutdown /r /t 0"'), 'powershell -Command shutdown blocked');
A.ok(breaksMachineState('powershell -NoProfile -Command "Stop-Computer"'), 'powershell -Command Stop-Computer blocked');
A.ok(breaksMachineState('pwsh -c "Restart-Computer"'), 'pwsh -c Restart-Computer blocked');
A.ok(breaksMachineState('sh -c "shutdown -h now"'), 'sh -c shutdown blocked');
A.ok(breaksMachineState('bash -c reboot'), 'bash -c reboot blocked');
A.ok(breaksMachineState('Start-Process shutdown -ArgumentList /r'), 'Start-Process shutdown blocked');
A.ok(breaksMachineState('echo hi\nshutdown /r'), 'newline-separated shutdown blocked');
A.ok(breaksMachineState('foo & reg add HKCU\\x /v y /d z'), 'reg add after & blocked');
A.ok(breaksMachineState('powershell -e UwB0AG8AcAAtAENvbXB1dGVy'), 'powershell -e (base64 encoded) blocked outright');
A.ok(breaksMachineState('powershell -EncodedCommand ABCDEF'), 'powershell -EncodedCommand blocked outright');
A.ok(breaksMachineState('schtasks /create /tn x /tr calc.exe & echo /query'), 'schtasks /create is NOT voided by a trailing /query');
// NON-trips that the hardening must preserve
A.eq(breaksMachineState('gcc -c file.c'), null, 'gcc -c (compile flag, not sh -c) allowed');
A.eq(breaksMachineState('grep -c pattern file.txt'), null, 'grep -c (count flag) allowed');
A.eq(breaksMachineState('powershell -ExecutionPolicy Bypass -File build.ps1'), null, 'powershell -ExecutionPolicy -File is NOT an encoded command');
A.eq(breaksMachineState('schtasks /query /tn x'), null, 'schtasks /query (read-only) allowed');
A.eq(breaksMachineState('echo restart-computer is a cmdlet'), null, 'the WORDS in an echo arg (no cmdlet at head) allowed');

// ---- network exposure rework: explicit all-interfaces binds blocked; client 0.0.0.0 + bare mentions allowed ----
A.ok(exposesNetwork('vite --host'), 'bare --host (framework binds 0.0.0.0) blocked');
A.ok(exposesNetwork('server --host=::'), '--host=:: (IPv6 all-interfaces) blocked');
A.ok(exposesNetwork('flask run --host 0.0.0.0'), '--host 0.0.0.0 (space form) blocked');
A.eq(exposesNetwork('curl http://0.0.0.0:3000/health'), null, 'curl to 0.0.0.0 (client target, resolves loopback) allowed');
A.eq(exposesNetwork('echo binding to 0.0.0.0 disabled'), null, 'echo mentioning 0.0.0.0 allowed');
A.eq(exposesNetwork('vite --host 127.0.0.1'), null, '--host 127.0.0.1 allowed');

// ---- integration: the real shell.exec tool refuses a machine-state command with a helpful message ----
const fs = require('fs'), path = require('path'), os = require('os');
const { spawn } = require('child_process');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-mach-'));
const tool = shell.makeShellTool({ spawn, fs, pathMod: path, root, clock: { now: () => 0 }, redact: s => s }).execTool;
const ctx = { agentId: 'a1', runId: 'r1', callId: 'c1', emit: () => {} };
(async () => {
  A.throws(() => tool.run({ cmd: 'shutdown /r /t 0' }, ctx), 'shutdown refused by the tool');
  A.throws(() => tool.run({ cmd: 'reg add HKCU\\x /v y /d z' }, ctx), 'reg add refused by the tool');
  A.throws(() => tool.run({ cmd: 'vite --host 0.0.0.0' }, ctx), '0.0.0.0 bind refused by the tool');
  // and a normal command still runs
  const r = await tool.run({ cmd: 'echo machine-floor-ok' }, ctx);
  A.ok(/machine-floor-ok/.test(r.content), 'ordinary command still runs under the machine floor');
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  A.report('shell-machine-state.test');
})().catch(e => { console.error(e); process.exit(1); });
