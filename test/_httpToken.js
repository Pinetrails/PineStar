'use strict';

async function bootToken(base, origin) {
  const headers = origin ? { Origin: origin } : undefined;
  const r = await fetch(base + '/', headers ? { headers } : undefined);
  const html = await r.text();
  const m = html.match(/window\.__STARNET_API_TOKEN__=("(?:\\.|[^"])*")/);
  if (!m) return '';
  try { return String(JSON.parse(m[1]) || ''); } catch (_) { return ''; }
}

module.exports = { bootToken };
