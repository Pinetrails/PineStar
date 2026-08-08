'use strict';

const FORMAT = 'starnet-skill-registry/v1';
function str(v) { return v == null ? '' : String(v); }
function makeSkillRegistry(deps) {
  const fetchDocument = deps && deps.fetchDocument;
  async function search(input) {
    if (typeof fetchDocument !== 'function') throw new Error('registry fetching is unavailable');
    const rawUrl = str(input && input.url).trim();
    let url; try { url = new URL(rawUrl); } catch (_) { throw new Error('enter a public HTTPS registry URL'); }
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('skill registries must use public HTTPS');
    const got = await fetchDocument(url.href);
    let index; try { index = JSON.parse(got.text); } catch (_) { throw new Error('registry returned invalid JSON'); }
    if (!index || index.format !== FORMAT || !Array.isArray(index.skills)) throw new Error('unsupported skill registry format');
    const q = str(input && input.query).trim().toLowerCase();
    const entries = index.skills.slice(0, 500).map(row => {
      let sourceUrl = '';
      try { sourceUrl = new URL(str(row && (row.sourceUrl || row.url)), got.url || url.href).href; } catch (_) {}
      return {
        name: str(row && row.name).slice(0, 80), description: str(row && row.description).slice(0, 280),
        sourceUrl, version: str(row && row.version).slice(0, 80), author: str(row && row.author).slice(0, 160),
        license: str(row && row.license).slice(0, 80), digest: str(row && row.digest).toLowerCase()
      };
    }).filter(row => row.name && /^https:\/\//.test(row.sourceUrl) && (!q || (row.name + ' ' + row.description + ' ' + row.author).toLowerCase().includes(q)));
    return { registryUrl: got.url || url.href, name: str(index.name || 'Skill registry').slice(0, 120), entries };
  }
  return { search };
}
module.exports = { FORMAT, makeSkillRegistry };
