/* STARNET updates.js
   Desktop Update Center: autonomous check loop + native Tauri updater bridge. */
'use strict';

const Updates = (() => {
  const KEY = 'starnet.updates.v1';
  // Human-browsable releases page — the GUARANTEED manual-update fallback when the in-app
  // updater can't complete (Gatekeeper on an unsigned mac build, a network/permission/disk
  // failure, an unsupported install layout). Reinstalling the latest build over the top keeps
  // ALL user data (workspaces live in Application Support; localStorage/IndexedDB in the WebView
  // store keyed by the unchanged bundle id — both OUTSIDE the app bundle the installer replaces).
  // Kept in sync with tauri.conf.json plugins.updater.endpoints[0] (same repo, /releases/latest).
  const RELEASES_PAGE = 'https://github.com/androoAGI/starnet-releases/releases/latest';
  const CORE = (typeof UpdateCore !== 'undefined') ? UpdateCore : null;
  const TAURI = (typeof window !== 'undefined' && window.__TAURI__ && window.__TAURI__.core) ? window.__TAURI__.core : null;
  const invoke = (cmd, args) => TAURI.invoke(cmd, args || {});
  const esc = s => (typeof U !== 'undefined' && U.esc) ? U.esc(String(s == null ? '' : s)) : String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let prefs = loadPrefs();
  let notify = () => {};
  let rerender = () => {};
  let timer = 0;
  let busy = false;
  // True once an update install has COMMITTED (past the GB-4 guard, invoke fired). On macOS/Linux
  // the install ends with app.restart(), which can emit a window close-requested event — the GB-4
  // quit guard (quitguard.js) MUST NOT block that close, or the files swap but the app never
  // relaunches (stuck update). Windows can't hit this: its updater process::exit()s before restart.
  // Set right before the install invoke; only cleared if the install throws (app still alive).
  let installing = false;
  let state = {
    desktop: !!TAURI,
    phase: TAURI ? 'idle' : 'unsupported',
    currentVersion: '',
    target: '',
    update: null,
    error: '',
    downloaded: 0,
    contentLength: 0,
    lastCheckedAt: prefs.lastCheckAt || 0,
    confirmRuns: 0
  };

  function loadPrefs() {
    if (!CORE) return { v: 1, autoCheck: false, lastCheckAt: 0, nextCheckAt: 0, remindAfter: 0, ignoredVersion: '', notifiedVersion: '', failureCount: 0 };
    try { return CORE.hydrateSettings(JSON.parse(localStorage.getItem(KEY))); }
    catch (_) { return CORE.hydrateSettings(null); }
  }
  function savePrefs() {
    try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch (_) {}
  }
  function cleanError(e) {
    const text = (e && (e.message || e.toString && e.toString())) || String(e || 'unknown error');
    return text.replace(/^Error:\s*/, '').trim();
  }
  function fmtTime(ts) {
    if (!ts) return 'never';
    try { return new Date(ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); }
    catch (_) { return 'recently'; }
  }
  function shortNotes(text) {
    text = String(text || '').trim();
    if (!text) return '';
    if (text.length > 520) text = text.slice(0, 520).trim() + '...';
    return text;
  }
  function snapshot() {
    return Object.assign({}, state, { prefs: Object.assign({}, prefs) });
  }
  function emit() {
    try { rerender('updates'); } catch (_) {}
  }

  async function init(opts) {
    opts = opts || {};
    notify = typeof opts.notify === 'function' ? opts.notify : notify;
    rerender = typeof opts.rerender === 'function' ? opts.rerender : rerender;
    await refreshStatus();
    runLoop('startup');
  }

  async function refreshStatus() {
    if (!TAURI || !CORE) {
      state.desktop = false;
      state.phase = 'unsupported';
      emit();
      return snapshot();
    }
    try {
      const r = await invoke('starnet_update_status');
      state.desktop = !!r.desktop;
      state.currentVersion = r.currentVersion || '';
      state.target = r.target || '';
      if (r.pending) {
        state.update = r.pending;
        state.phase = 'available';
      } else if (state.phase === 'idle') {
        state.phase = 'idle';
      }
      state.error = '';
    } catch (e) {
      state.phase = 'unsupported';
      state.error = cleanError(e);
    }
    emit();
    return snapshot();
  }

  function schedule() {
    clearTimeout(timer);
    if (!CORE) return;
    const now = Date.now();
    const action = CORE.nextAction({
      settings: prefs,
      runtime: { desktop: state.desktop, phase: state.phase, hasUpdate: !!state.update },
      now
    });
    if (action.action === 'check') {
      timer = setTimeout(() => runLoop('due'), 1000);
      return;
    }
    const nextAt = action.nextAt || (now + 60 * 60 * 1000);
    timer = setTimeout(() => runLoop(action.reason), Math.max(15000, nextAt - now));
  }

  function runLoop(reason) {
    if (!CORE) return;
    const action = CORE.nextAction({
      settings: prefs,
      runtime: { desktop: state.desktop, phase: state.phase, hasUpdate: !!state.update },
      now: Date.now()
    });
    if (action.action === 'check') {
      check(false, reason);
    } else {
      schedule();
    }
  }

  async function check(manual, reason) {
    if (!TAURI || !CORE || busy) return snapshot();
    busy = true;
    state.phase = 'checking';
    state.error = '';
    state.confirmRuns = 0;
    emit();
    try {
      const r = await invoke('starnet_update_check');
      prefs = CORE.recordCheckResult(prefs, r, Date.now());
      state.lastCheckedAt = r.checkedAt || Date.now();
      if (r.available && r.update) {
        state.update = r.update;
        state.phase = 'available';
        if (CORE.shouldNotify(prefs, r.update.version, Date.now(), !!r.update.critical)) {
          notify((r.update.critical ? 'Critical update' : 'StarNet update') + ' v' + r.update.version + ' is ready in Update Center', r.update.critical ? 'warn' : 'gold');
          prefs = CORE.recordNotified(prefs, r.update.version);
        }
      } else {
        state.update = null;
        state.phase = 'current';
        if (manual) notify('StarNet is up to date', 'good');
      }
      savePrefs();
    } catch (e) {
      state.phase = 'error';
      state.error = cleanError(e);
      prefs = CORE.recordCheckError(prefs, Date.now());
      savePrefs();
      if (manual) notify('Update check failed - ' + state.error, 'warn');
    } finally {
      busy = false;
      schedule();
      emit();
    }
    return snapshot();
  }

  // P1.3: bound any promise so a hung sidecar can't stall the update. Resolves to `fallback` on timeout/throw.
  // No AbortController here on purpose — CloudSave.flush()/App.pushRoster() already own their own fetch; we only
  // need to STOP WAITING on them, not cancel them (a slow write that lands after we move on is harmless).
  function withTimeout(promise, ms, fallback) {
    return Promise.race([
      Promise.resolve().then(() => promise).catch(() => fallback),
      new Promise(resolve => { try { setTimeout(() => resolve(fallback), ms); } catch (_) { resolve(fallback); } })
    ]);
  }

  // P1.3: flush the durable mirror + push the roster BEFORE the installer kills us, each time-boxed. Exposed on the
  // module API so it is unit-testable and CDP-drivable (prove the mirror advances before the install invoke fires).
  async function preInstallDrain(ms) {
    const budget = Math.max(250, +ms || 3000);
    const jobs = [];
    // force:true bypasses the backoff-hold — this is the app's last breath, attempt the write regardless of the
    // retry clock. A missing CloudSave (browser preview) just yields a resolved no-op.
    if (typeof CloudSave !== 'undefined' && CloudSave && typeof CloudSave.flush === 'function') {
      jobs.push(withTimeout(CloudSave.flush({ force: true }), budget, false));
    }
    // App.pushRoster() returns the in-flight roster POST promise (app.js). Missing/older App -> resolved no-op.
    if (typeof App !== 'undefined' && App && typeof App.pushRoster === 'function') {
      jobs.push(withTimeout(App.pushRoster(), budget, undefined));
    }
    try { await Promise.all(jobs); } catch (_) {}
  }

  // Count of sidecar-CONFIRMED live runs (Channels.busy flips on real agent.run.start/end,
  // never on hope) — the truthful input to the GB-4 install guard. 0 when Channels is absent
  // (browser preview), which is also the only context where installing is impossible anyway.
  function liveRunCount() {
    try {
      return (typeof Channels !== 'undefined' && Channels && typeof Channels.busyCount === 'function')
        ? Channels.busyCount() : 0;
    } catch (_) { return 0; }
  }

  async function install(opts) {
    opts = opts || {};
    if (!TAURI || !CORE || busy || !state.update) {
      notify('No StarNet update is ready to install', 'warn');
      return snapshot();
    }
    const Channel = TAURI.Channel;
    if (!Channel) {
      notify('Update progress channel is unavailable in this build', 'warn');
      return snapshot();
    }
    // GB-4: the installer restarts (NSIS: kills) the app, terminating every live provider
    // stream mid-run. Never do that as a click side effect — pause and make it an explicit
    // choice. `force` is set only by the INSTALL ANYWAY button on the guard card.
    const running = liveRunCount();
    const blockReason = CORE.installBlockReason ? CORE.installBlockReason(running, !!opts.force) : null;
    if (blockReason) {
      state.confirmRuns = running;
      notify('Update paused - ' + blockReason, 'warn');
      emit();
      return snapshot();
    }
    state.confirmRuns = 0;
    busy = true;
    state.phase = 'downloading';
    state.downloaded = 0;
    state.contentLength = 0;
    state.error = '';
    const onEvent = new Channel(event => handleInstallEvent(event));
    emit();
    // P1.3 (UPDATE_STATE_SAFETY_AUDIT): the NSIS installer kills the running app (CheckIfAppIsRunning), so the
    // last ~1.2s debounce window of world changes — and the newest roster — would be LOST on every in-app update.
    // Drain them FIRST: force one immediate durable-mirror flush + a roster push. Each is bounded (Promise.race
    // with a timeout) so a dead/slow sidecar can NEVER hang the update — a lost drain is strictly better than a
    // frozen updater. Best-effort throughout: any failure just proceeds to install (localStorage is intact).
    await preInstallDrain();
    installing = true;   // from here a close-requested is the update restart — quit guard must allow it
    try {
      await invoke('starnet_update_install', { onEvent });
      state.phase = 'restarting';
      notify('StarNet update installed - restarting', 'good');
    } catch (e) {
      installing = false;   // install failed; the app lives on, so the quit guard resumes normally
      state.phase = 'available';
      state.error = cleanError(e);
      notify('Update install failed - ' + state.error, 'warn');
    } finally {
      busy = false;
      emit();
    }
    return snapshot();
  }

  function handleInstallEvent(event) {
    if (!event || !event.event) return;
    if (event.event === 'Started') {
      state.phase = 'downloading';
      state.contentLength = +(event.data && event.data.contentLength) || 0;
      state.downloaded = 0;
    } else if (event.event === 'Progress') {
      state.phase = 'downloading';
      state.downloaded += +(event.data && event.data.chunkLength) || 0;
    } else if (event.event === 'Finished') {
      state.phase = 'installing';
    } else if (event.event === 'Installing') {
      state.phase = 'restarting';
    }
    emit();
  }

  function setAutoCheck(on) {
    prefs = CORE.setAutoCheck(prefs, !!on, Date.now());
    savePrefs();
    schedule();
    emit();
  }
  function remindLater() {
    if (!state.update) return;
    prefs = CORE.remindLater(prefs, state.update.version, Date.now());
    savePrefs();
    notify('Update reminder moved to tomorrow', '');
    schedule();
    emit();
  }
  function ignoreVersion() {
    if (!state.update) return;
    prefs = CORE.ignoreVersion(prefs, state.update.version);
    savePrefs();
    state.update = null;
    state.phase = 'idle';
    notify('StarNet v' + prefs.ignoredVersion + ' will be skipped', 'warn');
    schedule();
    emit();
  }

  function phaseLabel() {
    if (state.phase === 'unsupported') return 'desktop updater unavailable';
    if (state.phase === 'checking') return 'checking for updates';
    if (state.phase === 'available') return 'update ready';
    if (state.phase === 'downloading') return 'downloading update';
    if (state.phase === 'installing') return 'preparing installer';
    if (state.phase === 'restarting') return 'restarting';
    if (state.phase === 'current') return 'up to date';
    if (state.phase === 'error') return 'check failed';
    return 'ready';
  }

  function settingsHtml() {
    const auto = prefs.autoCheck !== false;
    return '<h4 class="ms-h">UPDATES</h4>' +
      '<div class="up-mini">' +
      '<div><b>' + esc(phaseLabel().toUpperCase()) + '</b><span>current v' + esc(state.currentVersion || 'unknown') + ' - last check ' + esc(fmtTime(state.lastCheckedAt)) + '</span></div>' +
      '<button class="bb sm" id="set-updates-open">UPDATE CENTER</button>' +
      '</div>' +
      '<label class="set-row"><input type="checkbox" id="set-updates-auto" ' + (auto ? 'checked' : '') + '> AUTO-CHECK FOR UPDATES</label>';
  }

  function wireSettings(body) {
    const auto = body.querySelector('#set-updates-auto');
    if (auto) auto.addEventListener('change', ev => setAutoCheck(ev.target.checked));
    const open = body.querySelector('#set-updates-open');
    if (open && typeof StationUI !== 'undefined' && StationUI.toggleTerm) {
      open.addEventListener('click', () => StationUI.toggleTerm('updates', 'UPDATE CENTER', render, { w: '540px' }));
    }
  }

  function render(body) {
    body.innerHTML = html();
    wire(body);
  }

  function html() {
    if (!TAURI) {
      return '<div class="fb-empty">DESKTOP UPDATES ARE AVAILABLE IN THE PACKAGED STARNET APP.<br><span>This browser preview cannot install native releases.</span></div>';
    }
    const update = state.update;
    const pct = CORE.progress(state.downloaded, state.contentLength);
    const notes = update ? shortNotes(update.body) : '';
    const auto = prefs.autoCheck !== false;
    let out = '<div class="up-center">' +
      '<div class="up-head"><div><b>' + esc(phaseLabel().toUpperCase()) + '</b><span>current v' + esc(state.currentVersion || 'unknown') + (state.target ? ' - ' + esc(state.target) : '') + '</span></div>' +
      '<button class="bb sm" id="up-check" ' + (busy ? 'disabled' : '') + '>CHECK NOW</button></div>' +
      '<label class="set-row up-auto"><input type="checkbox" id="up-auto" ' + (auto ? 'checked' : '') + '> CHECK AUTOMATICALLY</label>';
    if (update) {
      const guardN = state.confirmRuns | 0;
      out += '<div class="up-card ' + (update.critical ? 'critical' : '') + '">' +
        '<div class="up-version"><span>AVAILABLE</span><b>v' + esc(update.version) + '</b></div>' +
        (update.date ? '<div class="up-meta">published ' + esc(update.date) + '</div>' : '') +
        (notes ? '<pre class="up-notes">' + esc(notes) + '</pre>' : '<div class="up-meta">No release notes were provided.</div>');
      if (guardN > 0) {
        // GB-4 guard card: install was clicked while agents are live. The count is
        // Channels-confirmed, and the choice is the Commander's, not a side effect.
        out += '<div class="up-guard">' +
          esc(guardN === 1 ? '1 AGENT IS STILL WORKING' : guardN + ' AGENTS ARE STILL WORKING') +
          ' - INSTALLING RESTARTS STARNET AND KILLS ' + (guardN === 1 ? 'ITS RUN' : 'THEIR RUNS') + '.</div>' +
          '<div class="up-actions">' +
          '<button class="bb sm" id="up-guard-wait">WAIT FOR AGENTS</button>' +
          '<button class="bb sm danger" id="up-install-force" ' + (busy ? 'disabled' : '') + '>INSTALL ANYWAY</button>' +
          '</div></div>';
      } else {
        out += '<div class="up-actions"><button class="bb sm" id="up-install" ' + (busy ? 'disabled' : '') + '>INSTALL UPDATE</button>' +
          '<button class="bb sm" id="up-remind">REMIND TOMORROW</button>' +
          (update.critical ? '' : '<button class="bb sm danger" id="up-ignore">SKIP VERSION</button>') + '</div></div>';
      }
    } else {
      out += '<div class="up-empty">No update is pending. StarNet will keep checking in the background while automatic checks are on.</div>';
    }
    if (state.phase === 'downloading' || state.phase === 'installing' || state.phase === 'restarting') {
      out += '<div class="up-progress"><div style="width:' + pct + '%"></div></div>' +
        '<div class="up-meta">' + (state.contentLength ? (pct + '% downloaded') : phaseLabel()) + '</div>';
    }
    if (state.error) {
      // Auto-update failed — never leave the user stuck. Surface the manual path explicitly:
      // reinstalling the latest build keeps all data (see RELEASES_PAGE note).
      out += '<div class="up-error">' + esc(state.error) +
        '<br><button class="bb sm up-manual" id="up-manual-err">DOWNLOAD LATEST MANUALLY</button>' +
        '<span class="up-meta up-manual-note">Reinstalling over the top keeps your station and settings.</span></div>';
    }
    out += '<div class="up-foot">Last checked: ' + esc(fmtTime(state.lastCheckedAt)) +
      ' · <a href="#" id="up-manual-foot" class="up-manual-link">download manually</a></div></div>';
    return out;
  }

  // Open the releases page in the system browser — same invoke-with-fallback pattern app.js uses.
  function openReleasesPage() {
    try {
      if (TAURI && typeof TAURI.invoke === 'function') {
        TAURI.invoke('open_external_url', { url: RELEASES_PAGE }).catch(() => {
          try { window.open(RELEASES_PAGE, '_blank', 'noopener'); } catch (_) {}
        });
        return;
      }
    } catch (_) {}
    try { window.open(RELEASES_PAGE, '_blank', 'noopener'); } catch (_) {}
  }

  function wire(body) {
    const auto = body.querySelector('#up-auto');
    if (auto) auto.addEventListener('change', ev => setAutoCheck(ev.target.checked));
    const checkBtn = body.querySelector('#up-check');
    if (checkBtn) checkBtn.addEventListener('click', () => check(true, 'manual'));
    const installBtn = body.querySelector('#up-install');
    if (installBtn) installBtn.addEventListener('click', () => install());
    const forceBtn = body.querySelector('#up-install-force');
    if (forceBtn) forceBtn.addEventListener('click', () => install({ force: true }));
    const waitBtn = body.querySelector('#up-guard-wait');
    if (waitBtn) waitBtn.addEventListener('click', () => { state.confirmRuns = 0; emit(); });
    const remindBtn = body.querySelector('#up-remind');
    if (remindBtn) remindBtn.addEventListener('click', remindLater);
    const ignoreBtn = body.querySelector('#up-ignore');
    if (ignoreBtn) ignoreBtn.addEventListener('click', ignoreVersion);
    const manualErr = body.querySelector('#up-manual-err');
    if (manualErr) manualErr.addEventListener('click', openReleasesPage);
    const manualFoot = body.querySelector('#up-manual-foot');
    if (manualFoot) manualFoot.addEventListener('click', ev => { ev.preventDefault(); openReleasesPage(); });
  }

  return {
    init, refreshStatus, check, install, preInstallDrain, snapshot, settingsHtml, wireSettings, render,
    phase: () => state.phase,
    // True once an update install has committed — quitguard.js reads this so it never blocks the
    // macOS/Linux app.restart() close (Windows exits before restart, so it never asks).
    isInstalling: () => installing,
    prefs: () => Object.assign({}, prefs)
  };
})();
