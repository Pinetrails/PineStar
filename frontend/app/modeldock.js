/* STARNET quick model selector. Lives in COMMS beside voice controls; transport state stays in Harness. */
'use strict';

const ModelDock = (() => {
  const el = id => document.getElementById(id);
  const CODEX_MODELS = ['gpt-5.3-codex', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini'];
  const OPENROUTER_FALLBACK = [
    'anthropic/claude-sonnet-4.6',
    'anthropic/claude-opus-4.8',
    'openai/gpt-5',
    'google/gemini-2.5-pro',
    'x-ai/grok-4'
  ];
  const EFFORTS = [
    { id: 'none', label: 'OFF', title: 'Reasoning off' },
    { id: 'minimal', label: 'MIN', title: 'Minimal reasoning' },
    { id: 'low', label: 'LOW', title: 'Low reasoning' },
    { id: 'medium', label: 'MED', title: 'Medium reasoning' },
    { id: 'high', label: 'HIGH', title: 'High reasoning' },
    { id: 'xhigh', label: 'XHIGH', title: 'Extra-high reasoning' },
    { id: 'max', label: 'MAX', title: 'Maximum reasoning' }
  ];
  const CODEX_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh'];
  const OPENROUTER_REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  const REASONING_EFFORT_ORDER = OPENROUTER_REASONING_EFFORTS;
  const OFF_ONLY_EFFORTS = ['none'];
  const GROUP_NAMES = {
    anthropic: 'ANTHROPIC',
    openai: 'OPENAI',
    google: 'GOOGLE',
    'x-ai': 'XAI',
    meta: 'META',
    'meta-llama': 'META',
    mistralai: 'MISTRAL',
    deepseek: 'DEEPSEEK',
    qwen: 'QWEN',
    cohere: 'COHERE'
  };

  let opts = {};
  let wired = false;
  let open = false;
  let loading = false;
  let cache = {};
  let models = [];

  function provider() {
    const p = (typeof Harness !== 'undefined' && Harness.getProv) ? Harness.getProv() : 'openrouter';
    return normalizeProvider(p);
  }
  function providerLabel(p) {
    p = normalizeProvider(p);
    const map = { codex: 'GPT / CODEX', openrouter: 'OPENROUTER', openai: 'OPENAI API', ollama: 'OLLAMA', custom: 'CUSTOM' };
    return map[p] || String(p || 'openrouter').toUpperCase();
  }
  function normalizeProvider(p) {
    p = String(p || 'openrouter').trim().toLowerCase();
    if (p === 'codex' || p === 'openai-codex') return 'codex';
    if (p === 'openai' || p === 'openai-api') return 'openai';
    if (p === 'ollama' || p === 'ollama-local') return 'ollama';
    if (p === 'custom' || p === 'openai-compatible' || p === 'local' || p === 'vllm' || p === 'lmstudio') return 'custom';
    return 'openrouter';
  }
  function apiFetch(url, init) {
    return (typeof Harness !== 'undefined' && Harness.apiFetch) ? Harness.apiFetch(url, init) : fetch(url, init);
  }

  function normalizeEffort(value) {
    if (typeof Harness !== 'undefined' && Harness.normalizeReasoningEffort) return Harness.normalizeReasoningEffort(value);
    const key = String(value || 'medium').trim().toLowerCase().replace(/[\s_-]+/g, '');
    const map = {
      off: 'none', none: 'none', no: 'none', disabled: 'none',
      min: 'minimal', minimal: 'minimal',
      low: 'low',
      med: 'medium', mid: 'medium', medium: 'medium',
      high: 'high',
      extra: 'xhigh', xtra: 'xhigh', extrahigh: 'xhigh', xhigh: 'xhigh',
      max: 'max'
    };
    return map[key] || 'medium';
  }

  function currentEffort() {
    return normalizeEffort((typeof Harness !== 'undefined' && Harness.getReasoningEffort) ? Harness.getReasoningEffort() : 'medium');
  }

  function effortLabel(id) {
    id = normalizeEffort(id);
    const e = EFFORTS.find(x => x.id === id);
    return e ? e.label : 'MED';
  }

  function effortDef(id) {
    id = normalizeEffort(id);
    return EFFORTS.find(x => x.id === id) || EFFORTS[3];
  }

  function getModel() {
    return (typeof Harness !== 'undefined' && Harness.getModel) ? String(Harness.getModel() || '') : '';
  }

  function modelLabel(item) {
    const id = String((item && item.id) || '');
    const raw = String((item && item.name) || id.split('/').pop() || id || 'no model');
    return raw.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function groupOf(item) {
    return providerLabel((item && item.provider) || provider());
  }

  function asModel(item, p) {
    if (typeof item === 'string') return { id: item, name: item, provider: normalizeProvider(p) };
    const out = { id: String((item && item.id) || ''), name: (item && item.name) || String((item && item.id) || ''), provider: normalizeProvider(p) };
    const params = (item && (item.supported_parameters || item.supportedParameters)) || null;
    const efforts = (item && (item.reasoningEfforts || item.reasoning_efforts || item.supportedReasoningEfforts || item.supported_reasoning_efforts)) || null;
    if (Array.isArray(params)) out.supported_parameters = params.slice();
    if (Array.isArray(efforts)) out.reasoningEfforts = efforts.slice();
    if (item && item.supportsReasoning != null) out.supportsReasoning = !!item.supportsReasoning;
    if (item && item.supportsTools != null) out.supportsTools = !!item.supportsTools;
    return out;
  }

  function mergeCurrent(list) {
    const current = getModel();
    const p = provider();
    if (current && !list.some(m => m.id === current && normalizeProvider(m.provider) === p)) list.unshift({ id: current, name: current, provider: p });
    return list.filter(m => m && m.id);
  }

  function providerEnabled(p) {
    p = normalizeProvider(p || provider());
    if (p === provider()) return true;
    try {
      if (typeof Harness !== 'undefined' && Harness.getKey && Harness.getKey()) return true;
      if (typeof Harness !== 'undefined' && Harness.configured && Harness.configured(p)) return true;
    } catch (_) {}
    if (p === 'ollama') return true;
    return false;
  }

  async function codexEnabled() {
    if (provider() === 'codex') return true;
    try {
      const r = await apiFetch('/api/auth/codex/status', { cache: 'no-store' });
      const j = await r.json();
      return !!(j && j.connected);
    } catch (_) {
      return false;
    }
  }

  function openRouterGroupName(item) {
    const id = String((item && item.id) || '');
    const head = id.indexOf('/') >= 0 ? id.split('/')[0].toLowerCase() : 'custom';
    return GROUP_NAMES[head] || head.toUpperCase();
  }

  function modelFamily(item) {
    const p = normalizeProvider((item && item.provider) || provider());
    const id = String((item && item.id) || '').toLowerCase();
    const name = String((item && item.name) || '').toLowerCase();
    if (p === 'codex') return 'gpt';
    if (/^(openai|openai-internal)\//.test(id) || /\bgpt[-\s]?\d|\bgpt\b|codex/.test(id + ' ' + name)) return 'gpt';
    if (/^anthropic\//.test(id) || /claude/.test(id + ' ' + name)) return 'anthropic';
    if (/^google\//.test(id) || /gemini/.test(id + ' ' + name)) return 'google';
    return 'other';
  }

  function declaredEfforts(item) {
    const raw = item && (item.reasoningEfforts || item.reasoning_efforts || item.supportedReasoningEfforts || item.supported_reasoning_efforts);
    if (!Array.isArray(raw)) return [];
    const seen = new Set(), out = [];
    for (const v of raw) {
      const e = normalizeEffort(v);
      if (!seen.has(e)) { seen.add(e); out.push(e); }
    }
    return out.length ? out : [];
  }

  function supportsReasoning(item) {
    if (normalizeProvider((item && item.provider) || provider()) === 'codex') return true;
    if (item && item.supportsReasoning != null) return !!item.supportsReasoning;
    const params = item && (item.supported_parameters || item.supportedParameters);
    if (Array.isArray(params)) {
      const set = new Set(params.map(x => String(x).toLowerCase()));
      return set.has('reasoning') || set.has('reasoning_effort') || set.has('include_reasoning');
    }
    const fam = modelFamily(item);
    return fam === 'gpt' || fam === 'anthropic' || fam === 'google';
  }

  function effortOptionsFor(item) {
    const declared = declaredEfforts(item);
    if (declared.length) return declared;
    if (normalizeProvider((item && item.provider) || provider()) === 'codex') return CODEX_EFFORTS.slice();
    if (!supportsReasoning(item)) return OFF_ONLY_EFFORTS.slice();
    return OPENROUTER_REASONING_EFFORTS.slice();
  }

  function currentModelItem() {
    const id = getModel();
    const p = provider();
    return models.find(m => m.id === id && normalizeProvider(m.provider) === p) || { id, name: id, provider: p };
  }

  function clampEffortForModel(value, item) {
    const opts = effortOptionsFor(item);
    let effort = normalizeEffort(value);
    if (opts.indexOf(effort) >= 0) return effort;
    const set = new Set(opts);
    let idx = REASONING_EFFORT_ORDER.indexOf(effort);
    if (idx < 0) idx = REASONING_EFFORT_ORDER.indexOf('medium');
    for (let i = idx; i >= 0; i--) if (set.has(REASONING_EFFORT_ORDER[i])) return REASONING_EFFORT_ORDER[i];
    for (let i = idx + 1; i < REASONING_EFFORT_ORDER.length; i++) if (set.has(REASONING_EFFORT_ORDER[i])) return REASONING_EFFORT_ORDER[i];
    return opts[0] || 'none';
  }

  function effectiveEffort(item) {
    return clampEffortForModel(currentEffort(), item || currentModelItem());
  }

  function ensureCurrentEffort() {
    const item = currentModelItem();
    const raw = currentEffort();
    const effort = clampEffortForModel(raw, item);
    if (effort !== raw && typeof Harness !== 'undefined' && Harness.setReasoningEffort) Harness.setReasoningEffort(effort);
    return effort;
  }

  async function fetchProviderModels(p, force) {
    p = normalizeProvider(p);
    if (!force && cache[p] && cache[p].length) {
      return cache[p].slice();
    }
    let list = [];
    try {
      if (p === 'codex') {
        if (!(await codexEnabled())) { cache[p] = []; return []; }
        const r = await apiFetch('/api/auth/codex/models', { cache: 'no-store' });
        const j = await r.json();
        if (Array.isArray(j.models)) list = j.models.map(m => asModel(m, p));
      } else if (typeof Harness !== 'undefined' && Harness.listModels) {
        if (!providerEnabled(p)) { cache[p] = []; return []; }
        try {
          const q = (p === 'custom' && typeof Harness !== 'undefined' && Harness.getBaseUrl && Harness.getBaseUrl())
            ? ('?baseUrl=' + encodeURIComponent(Harness.getBaseUrl())) : '';
          const r = await apiFetch('/api/models/' + encodeURIComponent(p) + q, { cache: 'no-store' });
          const j = await r.json();
          if (Array.isArray(j.models) && j.models.length) list = j.models.map(m => asModel(m, p));
        } catch (_) {}
        if (!list.length) list = (await Harness.listModels(p)).map(m => asModel(m, p));
      }
    } catch (_) {}
    if (!list.length && (p === 'codex' || p === 'openrouter')) list = (p === 'codex' ? CODEX_MODELS : OPENROUTER_FALLBACK).map(m => asModel(m, p));
    list.sort((a, b) => {
      if (p === 'openrouter') {
        const ga = openRouterGroupName(a), gb = openRouterGroupName(b);
        if (ga !== gb) return ga.localeCompare(gb);
      }
      return modelLabel(a).localeCompare(modelLabel(b)) || a.id.localeCompare(b.id);
    });
    cache[p] = list.slice();
    return list;
  }

  async function fetchModels(force) {
    loading = true;
    renderList();
    const ids = ['codex', 'openrouter', 'openai', 'ollama', 'custom'];
    const active = provider();
    if (ids.indexOf(active) < 0) ids.unshift(active);
    const parts = await Promise.all(ids.map(p => fetchProviderModels(p, force)));
    models = mergeCurrent(parts.reduce((a, b) => a.concat(b), []));
    models.sort((a, b) => {
      const pa = normalizeProvider(a.provider), pb = normalizeProvider(b.provider);
      if (pa !== pb) return (pa === 'codex' ? 0 : pa === 'openrouter' ? 1 : 2) - (pb === 'codex' ? 0 : pb === 'openrouter' ? 1 : 2);
      if (pa === 'openrouter') {
        const ga = openRouterGroupName(a), gb = openRouterGroupName(b);
        if (ga !== gb) return ga.localeCompare(gb);
      }
      return modelLabel(a).localeCompare(modelLabel(b)) || a.id.localeCompare(b.id);
    });
    loading = false;
    renderList();
    reflect();
    return models;
  }

  function renderEfforts() {
    const wrap = el('model-dock-efforts');
    if (!wrap) return;
    wrap.innerHTML = '';
    const item = currentModelItem();
    const selected = ensureCurrentEffort();
    const available = effortOptionsFor(item).map(effortDef);
    for (const e of available) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'model-dock-effort' + (e.id === selected ? ' sel' : '');
      b.textContent = e.label;
      b.title = e.title;
      b.setAttribute('role', 'option');
      b.setAttribute('aria-selected', String(e.id === selected));
      b.addEventListener('click', () => applyEffort(e.id));
      wrap.appendChild(b);
    }
  }

  function renderList() {
    const wrap = el('model-dock-list');
    if (!wrap) return;
    wrap.innerHTML = '';
    if (loading) {
      const div = document.createElement('div');
      div.className = 'model-dock-empty';
      div.textContent = 'SCANNING CATALOG';
      wrap.appendChild(div);
      return;
    }
    const q = String((el('model-dock-search') && el('model-dock-search').value) || '').trim().toLowerCase();
    const current = getModel();
    const activeProvider = provider();
    const list = models.filter(m => {
      if (!q) return true;
      return (m.id + ' ' + modelLabel(m) + ' ' + groupOf(m) + ' ' + openRouterGroupName(m)).toLowerCase().indexOf(q) >= 0;
    });
    if (!list.length) {
      const div = document.createElement('div');
      div.className = 'model-dock-empty';
      div.textContent = 'NO MATCHES';
      wrap.appendChild(div);
      return;
    }
    let group = '';
    const frag = document.createDocumentFragment();
    for (const m of list) {
      const g = groupOf(m);
      if (g !== group) {
        group = g;
        const head = document.createElement('div');
        head.className = 'model-dock-group';
        head.textContent = group;
        frag.appendChild(head);
      }
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'model-dock-row' + (m.id === current && normalizeProvider(m.provider) === activeProvider ? ' sel' : '');
      row.title = m.id;
      row.dataset.provider = normalizeProvider(m.provider);
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(m.id === current && normalizeProvider(m.provider) === activeProvider));
      const name = document.createElement('span');
      name.className = 'model-dock-row-name';
      name.textContent = modelLabel(m);
      const eff = document.createElement('span');
      eff.className = 'model-dock-row-effort';
      eff.textContent = effortLabel(effectiveEffort(m));
      row.appendChild(name);
      row.appendChild(eff);
      row.addEventListener('click', () => applyModel(m));
      frag.appendChild(row);
    }
    wrap.appendChild(frag);
  }

  function applyModel(item) {
    const picked = typeof item === 'string' ? { id: item, provider: provider() } : (item || {});
    const id = String(picked.id || '').trim();
    const pickedProvider = normalizeProvider(picked.provider || provider());
    if (!id) return;
    const effort = clampEffortForModel(currentEffort(), picked);
    if (typeof Harness !== 'undefined' && Harness.setProv) Harness.setProv(pickedProvider);
    if (typeof Harness !== 'undefined' && Harness.setModel) Harness.setModel(id);
    if (typeof Harness !== 'undefined' && Harness.setReasoningEffort) Harness.setReasoningEffort(effort);
    if (opts.apply) opts.apply({ model: id, provider: pickedProvider, effort: effort, reason: 'model' });
    reflect();
    renderList();
    closeDock();
  }

  function applyEffort(id) {
    const effort = clampEffortForModel(id, currentModelItem());
    if (typeof Harness !== 'undefined' && Harness.setReasoningEffort) Harness.setReasoningEffort(effort);
    if (opts.apply) opts.apply({ model: getModel(), provider: provider(), effort: effort, reason: 'effort' });
    reflect();
    renderEfforts();
    renderList();
  }

  function reflect() {
    const current = getModel();
    const p = provider();
    const providerEl = el('model-dock-provider');
    const currentEl = el('model-dock-current-model');
    const chip = el('model-dock-effort-chip');
    if (providerEl) providerEl.textContent = providerLabel(p);
    if (currentEl) currentEl.textContent = current ? modelLabel({ id: current }) : 'NO MODEL';
    const effort = ensureCurrentEffort();
    if (chip) chip.textContent = effortLabel(effort);
    renderEfforts();
  }

  function openDock() {
    const dock = el('model-dock'), toggle = el('model-dock-toggle'), search = el('model-dock-search');
    if (!dock || !toggle) return;
    open = true;
    dock.hidden = false;
    toggle.classList.add('on');
    toggle.setAttribute('aria-expanded', 'true');
    reflect();
    fetchModels(false).then(() => { if (open) renderList(); });
    setTimeout(() => { try { if (search) search.focus(); } catch (_) {} }, 0);
  }

  function closeDock() {
    const dock = el('model-dock'), toggle = el('model-dock-toggle');
    open = false;
    if (dock) dock.hidden = true;
    if (toggle) {
      toggle.classList.remove('on');
      toggle.setAttribute('aria-expanded', 'false');
    }
  }

  function toggleDock() {
    if (open) closeDock(); else openDock();
  }

  function openSettings() {
    closeDock();
    const button = document.querySelector('.bb[data-term="settings"]');
    if (button) button.click();
  }

  function wire() {
    if (wired) return;
    wired = true;
    const toggle = el('model-dock-toggle');
    const search = el('model-dock-search');
    const refresh = el('model-dock-refresh');
    const settings = el('model-dock-settings');
    if (toggle) toggle.addEventListener('click', ev => { ev.preventDefault(); ev.stopPropagation(); toggleDock(); });
    if (search) search.addEventListener('input', renderList);
    if (refresh) refresh.addEventListener('click', () => fetchModels(true));
    if (settings) settings.addEventListener('click', openSettings);
    document.addEventListener('click', ev => {
      const dock = el('model-dock'), button = el('model-dock-toggle');
      if (!open || !dock || !button) return;
      if (dock.contains(ev.target) || button.contains(ev.target)) return;
      closeDock();
    });
    document.addEventListener('keydown', ev => { if (open && ev.key === 'Escape') closeDock(); });
  }

  function init(o) {
    opts = Object.assign({}, opts, o || {});
    wire();
    reflect();
    fetchModels(false).catch(() => { loading = false; renderList(); });
  }

  return {
    init,
    refresh: () => fetchModels(true),
    reflect,
    close: closeDock,
    normalizeEffort,
    _internals: { effortOptionsFor, clampEffortForModel, modelFamily, supportsReasoning }
  };
})();
