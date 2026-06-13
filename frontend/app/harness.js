/* SKYNET — harness.js : the REAL agent harness (BYOK).
   Owns the model connection + streaming + token/cost accounting.

   For this prototype the call goes browser -> OpenRouter directly (CORS-friendly,
   key in localStorage). In the shipped desktop build this exact interface is
   re-implemented behind the Tauri sidecar + OS keychain — callers (chat.js) never
   change, only the transport inside Harness.chat() does. Keep that seam clean. */
'use strict';

const Harness = (() => {
  const LS = { key: 'skynet.byok.key', model: 'skynet.byok.model', prov: 'skynet.byok.prov' };
  const OR = 'https://openrouter.ai/api/v1';

  let totals = { tokens: 0, cost: 0, calls: 0 };
  let modelMap = {};   // id -> { id, name, pricing }

  const getKey = () => localStorage.getItem(LS.key) || '';
  const setKey = k => localStorage.setItem(LS.key, k || '');
  const getModel = () => localStorage.getItem(LS.model) || '';
  const setModel = m => localStorage.setItem(LS.model, m || '');
  const getProv = () => localStorage.getItem(LS.prov) || 'openrouter';
  const setProv = p => localStorage.setItem(LS.prov, p || 'openrouter');

  /* per-million pricing for a model id, if known from the catalog */
  function priceOf(id) {
    const m = modelMap[id];
    if (!m || !m.pricing) return null;
    const inP = parseFloat(m.pricing.prompt) * 1e6;
    const outP = parseFloat(m.pricing.completion) * 1e6;
    if (!isFinite(inP) || !isFinite(outP)) return null;
    return { in: inP, out: outP };
  }

  /* public model catalog (no key required) — populates the connect dropdown */
  async function listModels() {
    try {
      const r = await fetch(OR + '/models', { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      const list = (j.data || []).map(m => ({ id: m.id, name: m.name, pricing: m.pricing }));
      list.sort((a, b) => a.id.localeCompare(b.id));
      modelMap = {};
      for (const m of list) modelMap[m.id] = m;
      return list;
    } catch (e) {
      console.warn('[harness] model list unavailable:', e.message);
      return [];
    }
  }

  /* stream a chat completion. messages = [{role,content}]; system prepended.
     onToken(deltaText) fires per chunk; onUsage(usage) fires when usage arrives. */
  async function chat({ system, messages, onToken, onUsage, signal }) {
    const key = getKey(), model = getModel();
    if (!key) throw new Error('no API key set');
    if (!model) throw new Error('no model selected');

    const body = {
      model,
      messages: system ? [{ role: 'system', content: system }, ...messages] : messages,
      stream: true,
      usage: { include: true }   // OpenRouter returns token + cost usage in-stream
    };

    const res = await fetch(OR + '/chat/completions', {
      method: 'POST', signal,
      headers: {
        'Authorization': 'Bearer ' + key,
        'Content-Type': 'application/json',
        'HTTP-Referer': location.origin,
        'X-Title': 'SKYNET'
      },
      body: JSON.stringify(body)
    });

    if (!res.ok || !res.body) {
      let detail = res.statusText;
      try { const j = await res.json(); detail = (j.error && j.error.message) || JSON.stringify(j); }
      catch (_) { try { detail = (await res.text()).slice(0, 300); } catch (__) {} }
      throw new Error('HTTP ' + res.status + ' — ' + detail);
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', full = '', lastUsage = null;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line || line.startsWith(':')) continue;   // keepalive comment
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let j; try { j = JSON.parse(data); } catch (_) { continue; }
        const delta = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
        if (delta) { full += delta; onToken && onToken(delta); }
        if (j.usage) lastUsage = j.usage;
      }
    }

    totals.calls++;
    if (lastUsage) {
      totals.tokens += lastUsage.total_tokens || ((lastUsage.prompt_tokens || 0) + (lastUsage.completion_tokens || 0));
      if (lastUsage.cost != null) totals.cost += lastUsage.cost;
      else { // fall back to catalog pricing if the provider didn't return a dollar cost
        const p = priceOf(model);
        if (p) totals.cost += ((lastUsage.prompt_tokens || 0) * p.in + (lastUsage.completion_tokens || 0) * p.out) / 1e6;
      }
      onUsage && onUsage(lastUsage);
    }
    return { text: full, usage: lastUsage };
  }

  return {
    getKey, setKey, getModel, setModel, getProv, setProv,
    listModels, priceOf, chat,
    totals: () => totals,
    setTotals: t => { totals = { tokens: t.tokens || 0, cost: t.cost || 0, calls: t.calls || 0 }; },
    resetTotals: () => { totals = { tokens: 0, cost: 0, calls: 0 }; }
  };
})();
