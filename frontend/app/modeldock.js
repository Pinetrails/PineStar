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
    { id: 'xhigh', label: 'XHIGH', title: 'Extra-high reasoning' }
  ];
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
    return p === 'codex' || p === 'openai-codex' ? 'codex' : 'openrouter';
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
      extra: 'xhigh', xtra: 'xhigh', extrahigh: 'xhigh', xhigh: 'xhigh', max: 'xhigh'
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

  function getModel() {
    return (typeof Harness !== 'undefined' && Harness.getModel) ? String(Harness.getModel() || '') : '';
  }

  function modelLabel(item) {
    const id = String((item && item.id) || '');
    const raw = String((item && item.name) || id.split('/').pop() || id || 'no model');
    return raw.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function groupOf(item) {
    if (provider() === 'codex') return 'OPENAI CODEX';
    const id = String((item && item.id) || '');
    const head = id.indexOf('/') >= 0 ? id.split('/')[0].toLowerCase() : 'custom';
    return GROUP_NAMES[head] || head.toUpperCase();
  }

  function asModel(item) {
    if (typeof item === 'string') return { id: item, name: item };
    return { id: String((item && item.id) || ''), name: (item && item.name) || String((item && item.id) || '') };
  }

  function mergeCurrent(list) {
    const current = getModel();
    if (current && !list.some(m => m.id === current)) list.unshift({ id: current, name: current });
    return list.filter(m => m && m.id);
  }

  async function fetchModels(force) {
    const p = provider();
    if (!force && cache[p] && cache[p].length) {
      models = mergeCurrent(cache[p].slice());
      return models;
    }
    loading = true;
    renderList();
    let list = [];
    try {
      if (p === 'codex') {
        const r = await fetch('/api/auth/codex/models', { cache: 'no-store' });
        const j = await r.json();
        if (Array.isArray(j.models)) list = j.models.map(asModel);
      } else if (typeof Harness !== 'undefined' && Harness.listModels) {
        list = (await Harness.listModels()).map(asModel);
      }
    } catch (_) {}
    if (!list.length) list = (p === 'codex' ? CODEX_MODELS : OPENROUTER_FALLBACK).map(asModel);
    list.sort((a, b) => groupOf(a).localeCompare(groupOf(b)) || modelLabel(a).localeCompare(modelLabel(b)) || a.id.localeCompare(b.id));
    cache[p] = list.slice();
    models = mergeCurrent(list.slice());
    loading = false;
    renderList();
    reflect();
    return models;
  }

  function renderEfforts() {
    const wrap = el('model-dock-efforts');
    if (!wrap) return;
    wrap.innerHTML = '';
    const selected = currentEffort();
    for (const e of EFFORTS) {
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
    const list = models.filter(m => {
      if (!q) return true;
      return (m.id + ' ' + modelLabel(m) + ' ' + groupOf(m)).toLowerCase().indexOf(q) >= 0;
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
      row.className = 'model-dock-row' + (m.id === current ? ' sel' : '');
      row.title = m.id;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(m.id === current));
      const name = document.createElement('span');
      name.className = 'model-dock-row-name';
      name.textContent = modelLabel(m);
      const eff = document.createElement('span');
      eff.className = 'model-dock-row-effort';
      eff.textContent = effortLabel(currentEffort());
      row.appendChild(name);
      row.appendChild(eff);
      row.addEventListener('click', () => applyModel(m.id));
      frag.appendChild(row);
    }
    wrap.appendChild(frag);
  }

  function applyModel(id) {
    id = String(id || '').trim();
    if (!id) return;
    if (typeof Harness !== 'undefined' && Harness.setModel) Harness.setModel(id);
    if (opts.apply) opts.apply({ model: id, effort: currentEffort(), reason: 'model' });
    reflect();
    renderList();
    closeDock();
  }

  function applyEffort(id) {
    const effort = normalizeEffort(id);
    if (typeof Harness !== 'undefined' && Harness.setReasoningEffort) Harness.setReasoningEffort(effort);
    if (opts.apply) opts.apply({ model: getModel(), effort: effort, reason: 'effort' });
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
    if (providerEl) providerEl.textContent = p === 'codex' ? 'OPENAI CODEX' : 'OPENROUTER';
    if (currentEl) currentEl.textContent = current ? modelLabel({ id: current }) : 'NO MODEL';
    if (chip) chip.textContent = effortLabel(currentEffort());
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
    normalizeEffort
  };
})();
