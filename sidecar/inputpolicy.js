/* sidecar/inputpolicy.js — host authority for physical-input isolation.

   Every current runOnce flow is synthetic-only. This module removes physical computer.use and
   real-screen desktop.open from the resolved capability set before provider tool definitions
   are built and stamps the dispatch context with an explicit deny. Prompt text, isTask,
   surface:'interactive', Full Access, and permanent consent are deliberately irrelevant.

   A future attended-control feature must be a separate host-minted, one-shot runId+callId lease;
   it must not weaken these ordinary task/autonomous/test helpers. */
'use strict';

const REAL_DESKTOP_TOOLS = new Set(['computer.use', 'desktop.open']);
const IMPACTS = Object.freeze({
  NONE: 'none',
  SYNTHETIC_BROWSER: 'synthetic-browser',
  WORKSPACE_PROCESS: 'workspace-process',
  MEDIA_CONTROL: 'media-control',
  EXTERNAL_SERVICE: 'external-service',
  // A network call that SPENDS one of the Commander's stored credentials (web_request). Deliberately its
  // own class, between external-service and external-unknown: unlike web_fetch it can act as the user on a
  // third-party account, but unlike shell.exec it grants NO host-process capability — no spawn, no
  // filesystem, no arbitrary binary. That is why it may run unattended where a shell may not; the blast
  // radius is exactly "one HTTPS request to a host, using a key the Commander explicitly approved for
  // unattended use". The per-key grant is enforced at the tool (servicekeys.resolveForRequest), which is
  // the only layer that knows WHICH key a given call spends.
  EXTERNAL_CREDENTIALED: 'external-credentialed',
  EXTERNAL_UNKNOWN: 'external-unknown',
  VISIBLE_DESKTOP: 'visible-desktop',
  PHYSICAL_INPUT: 'physical-input'
});
const IMPACT_SET = new Set(Object.keys(IMPACTS).map(k => IMPACTS[k]));
// 'taskbrief' = the host's OWN internal Task Brief controls (brief.ask / brief.proceed): read-only
// bookkeeping against a host-side store with zero external effect. Without it they fell through to
// EXTERNAL_UNKNOWN and the host demanded a per-call confirmation for the tool whose whole job is
// asking the Commander a question (live-caught 2026-07-16: three approval cards to ask one question).
const SAFE_BUILTIN_CAPS = new Set(['compute', 'cabinet', 'memory', 'quest', 'studio', 'orchestrator', 'taskbrief']);

function impactOfTool(tool) {
  tool = tool || {};
  if (IMPACT_SET.has(tool.impact)) return tool.impact;
  const name = String(tool.name || '');
  const cap = String(tool.capability || '');
  if (name === 'computer.use' || cap === 'physical-input') return IMPACTS.PHYSICAL_INPUT;
  if (name === 'desktop.open' || cap === 'visible-desktop') return IMPACTS.VISIBLE_DESKTOP;
  if (/^browser\./.test(name)) return IMPACTS.SYNTHETIC_BROWSER;
  if (name === 'shell.exec' || name === 'verify.run') return IMPACTS.WORKSPACE_PROCESS;
  if (/^shell\.bg\.(?:status|kill)$/.test(name)) return IMPACTS.NONE;
  if (/^spotify_(?:play|pause|next|previous|queue)$/.test(name) || cap === 'jukebox') return IMPACTS.MEDIA_CONTROL;
  if (SAFE_BUILTIN_CAPS.has(cap)) return IMPACTS.NONE;
  if (cap === 'web' && !/^browser\./.test(name)) return IMPACTS.EXTERNAL_SERVICE;
  // Dynamic/unknown capabilities fail closed. MCP translation classifies every custom
  // connector as external-unknown regardless of transport or self-declared annotations.
  return IMPACTS.EXTERNAL_UNKNOWN;
}

function makeRunAuthority(opts) {
  opts = opts || {};
  const surface = opts.surface === 'interactive' ? 'interactive' : 'autonomous';
  const isTask = !!opts.isTask;
  const environment = opts.environment || null;
  const confirm = typeof opts.confirm === 'function' ? opts.confirm : null;
  const isolated = !!(environment && environment.supports && (environment.supports.userControlIsolation === true || environment.supports.hostileCodeSandbox === true));
  function project(tool) {
    const impact = impactOfTool(tool);
    if (impact === IMPACTS.PHYSICAL_INPUT || impact === IMPACTS.VISIBLE_DESKTOP) return false;
    if (impact === IMPACTS.EXTERNAL_UNKNOWN) return surface === 'interactive' && !!confirm;
    if (surface !== 'interactive' && (impact === IMPACTS.WORKSPACE_PROCESS || impact === IMPACTS.MEDIA_CONTROL)) return false;
    return true;
  }
  function authorize(call, tool) {
    const impact = impactOfTool(tool);
    if (impact === IMPACTS.PHYSICAL_INPUT || impact === IMPACTS.VISIBLE_DESKTOP) {
      return { ok: false, impact, reason: impact + ' is unavailable to ordinary StarNet runs; no native one-shot user lease exists' };
    }
    if (impact === IMPACTS.EXTERNAL_UNKNOWN) {
      if (surface !== 'interactive' || !confirm) return { ok: false, impact, reason: 'unknown external effects require a watched, exact per-call confirmation' };
      // Deliberately bypass the standing-grant broker: any affirmative UI choice authorizes
      // this call ONCE only. "Always", Full Access, and cached grants are not recorded here.
      return Promise.resolve(confirm(call, tool)).then(decision => {
        const allow = /^(?:once|session|always|full)$/i.test(String(decision || ''));
        return allow
          ? { ok: true, impact, surface, isTask, isolated, oneShot: true }
          : { ok: false, impact, reason: 'exact external-effect confirmation was denied' };
      }, () => ({ ok: false, impact, reason: 'exact external-effect confirmation failed' }));
    }
    // Full Access, cached grants, and task text never turn an unattended run into authority
    // over a host process or the user's active media session. This gate runs before consent.
    if (surface !== 'interactive' && (impact === IMPACTS.WORKSPACE_PROCESS || impact === IMPACTS.MEDIA_CONTROL)) {
      return { ok: false, impact, reason: 'unattended runs cannot use ' + impact + ' even under Full Access' };
    }
    return { ok: true, impact, surface, isTask, isolated };
  }
  return Object.freeze({ mode: 'preserve-user-control', surface, isTask, isolated, project, authorize });
}

function enforceRunAuthority(resolved, registry, authority) {
  resolved = resolved || {};
  const allowed = new Set();
  for (const name of (resolved.tools || [])) {
    const tool = registry && typeof registry.get === 'function' ? registry.get(name) : null;
    const projected = tool && authority && typeof authority.project === 'function'
      ? authority.project(tool) : false;
    if (projected === true) allowed.add(name);
  }
  const approvalRules = {};
  const networkCaps = {};
  for (const name of allowed) {
    if (resolved.approvalRules && resolved.approvalRules[name]) approvalRules[name] = resolved.approvalRules[name];
    if (resolved.networkCaps && resolved.networkCaps[name]) networkCaps[name] = resolved.networkCaps[name];
  }
  return Object.assign({}, resolved, {
    tools: (resolved.tools || []).filter(name => allowed.has(name)),
    grants: (resolved.grants || []).filter(g => g && allowed.has(g.tool)),
    approvalRules,
    networkCaps
  });
}

function enforceSyntheticOnly(resolved) {
  resolved = resolved || {};
  const approvalRules = Object.assign({}, resolved.approvalRules || {});
  const networkCaps = Object.assign({}, resolved.networkCaps || {});
  for (const tool of REAL_DESKTOP_TOOLS) {
    delete approvalRules[tool];
    delete networkCaps[tool];
  }
  return Object.assign({}, resolved, {
    tools: (resolved.tools || []).filter(t => !REAL_DESKTOP_TOOLS.has(t)),
    grants: (resolved.grants || []).filter(g => g && !REAL_DESKTOP_TOOLS.has(g.tool)),
    approvalRules,
    networkCaps
  });
}

function runInputContext(surface, isTask) {
  return {
    surface: surface || 'autonomous',
    isTask: !!isTask,
    physicalInputAuthorized: false,
    inputMode: 'synthetic'
  };
}

// Bind browser.test_navigate to the URL the agent-owned background server actually
// advertised, not merely a requested command-line port (Vite may fall back 5173 -> 5174).
function backgroundOwnsLoopbackUrl(status, rawUrl) {
  if (!status || !status.running || status.killed) return false;
  let requested;
  try { requested = new URL(rawUrl); } catch (_) { return false; }
  const h = String(requested.hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (h !== 'localhost' && h !== '127.0.0.1' && h !== '::1') return false;
  const requestedPort = Number(requested.port || (requested.protocol === 'https:' ? 443 : 80));
  const tail = String(status.tail || '').replace(/\x1b\[[0-9;]*m/g, '');
  const re = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::(\d{1,5}))?/ig;
  let m;
  while ((m = re.exec(tail))) {
    const endpointPort = Number(m[1] || (/^https:/i.test(m[0]) ? 443 : 80));
    if (endpointPort === requestedPort) return true;
  }
  return false;
}

function loopbackPort(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const h = String(u.hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
    if (h !== 'localhost' && h !== '127.0.0.1' && h !== '::1') return 0;
    return Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  } catch (_) { return 0; }
}

// OS-backed listener ownership: the process listening on the requested port must be the
// background handle's PID or one of its descendants. Every ambient dependency is injected.
function makeLoopbackListenerProbe(opts) {
  opts = opts || {};
  const run = opts.execFile, platform = opts.platform || process.platform, env = opts.env || process.env;
  return async function listenerOwned(status, rawUrl) {
    const port = loopbackPort(rawUrl), rootPid = Number(status && status.pid);
    if (typeof run !== 'function' || !Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(rootPid) || rootPid < 1) return false;
    let exe, args;
    if (platform === 'win32') {
      exe = env.SystemRoot ? env.SystemRoot + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' : 'powershell.exe';
      const script = '$port=' + port + ';$root=' + rootPid + ';$parents=@{};Get-CimInstance Win32_Process|%{$parents[[uint32]$_.ProcessId]=[uint32]$_.ParentProcessId};$owners=@(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue|Select-Object -ExpandProperty OwningProcess -Unique);if($owners.Count -eq 0){exit 3};foreach($owner in $owners){$owned=$false;$p=[uint32]$owner;for($i=0;$i -lt 128 -and $p -ne 0;$i++){if($p -eq $root){$owned=$true;break};if(-not $parents.ContainsKey($p)){break};$next=$parents[$p];if($next -eq $p){break};$p=$next};if(-not $owned){exit 3}};exit 0';
      args = ['-NoProfile', '-NonInteractive', '-Command', script];
    } else if (platform === 'linux' || platform === 'darwin') {
      exe = '/bin/sh';
      const script = 'owners="$(lsof -nP -t -iTCP:"$1" -sTCP:LISTEN 2>/dev/null || true)"; [ -n "$owners" ] || exit 3; for owner in $owners; do p="$owner"; i=0; owned=0; while [ "$p" -gt 0 ] 2>/dev/null && [ "$i" -lt 128 ]; do if [ "$p" = "$2" ]; then owned=1; break; fi; next="$(ps -o ppid= -p "$p" 2>/dev/null | tr -d " ")"; [ -n "$next" ] || break; [ "$next" = "$p" ] && break; p="$next"; i=$((i+1)); done; [ "$owned" = 1 ] || exit 3; done; exit 0';
      args = ['-c', script, 'starnet-listener-probe', String(port), String(rootPid)];
    } else return false;
    return new Promise(resolve => {
      try { run(exe, args, { windowsHide: true, timeout: 5000 }, err => resolve(!err)); }
      catch (_) { resolve(false); }
    });
  };
}

async function backgroundOwnsLocalUrl(status, rawUrl, listenerProbe) {
  if (!backgroundOwnsLoopbackUrl(status, rawUrl) || typeof listenerProbe !== 'function') return false;
  try { return await listenerProbe(status, rawUrl) === true; } catch (_) { return false; }
}

module.exports = { enforceSyntheticOnly, enforceRunAuthority, runInputContext, impactOfTool, makeRunAuthority, IMPACTS, backgroundOwnsLoopbackUrl, backgroundOwnsLocalUrl, makeLoopbackListenerProbe, REAL_DESKTOP_TOOLS };
