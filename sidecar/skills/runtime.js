/* sidecar/skills/runtime.js - prompt index for runtime-created agent skills.

   Bundled recipes inject full bodies because they are curated and capability
   gated. Agent-created skills use progressive disclosure: every run sees the
   compact index, and the model must call skill.view when a listed skill is
   even partly relevant.
*/
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).runtimeSkills = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function str(v) { return v == null ? '' : String(v); }
  function isLive(s) { return s && s.state !== 'archived'; }
  function cleanLine(s) { return str(s).replace(/\s+/g, ' ').trim(); }

  function composeIndex(skills, opts) {
    opts = opts || {};
    const budget = opts.budget > 0 ? opts.budget : 6000;
    const live = (Array.isArray(skills) ? skills : []).filter(isLive);
    if (!live.length) return { text: '', ids: [], omitted: 0 };

    const canManage = opts.canManage !== false;
    const parts = [];
    const ids = [];
    let used = 0, omitted = 0;
    for (const s of live) {
      const bits = [];
      bits.push('- ' + cleanLine(s.name || s.id || 'Skill'));
      if (s.summary) bits.push(' -- ' + cleanLine(s.summary));
      const meta = [];
      if (s.category) meta.push(cleanLine(s.category));
      if (s.state && s.state !== 'active') meta.push(cleanLine(s.state));
      if (s.pinned) meta.push('pinned');
      if (s.files && s.files.length) meta.push(String(s.files.length) + ' support file' + (s.files.length === 1 ? '' : 's'));
      if (meta.length) bits.push(' [' + meta.join(', ') + ']');
      if (s.id) bits.push(' (id: ' + cleanLine(s.id) + ')');
      const line = bits.join('');
      if (parts.length && used + line.length > budget) { omitted++; continue; }
      parts.push(line); used += line.length; if (s.id) ids.push(s.id);
    }
    if (!parts.length) return { text: '', ids: [], omitted: live.length };

    const manage = canManage
      ? 'If the task teaches a reusable procedure, update an existing skill or create a new one with skill.manage.'
      : 'If the task teaches a reusable procedure, save it with skill.write.';
    const head = '\n\n## SAVED AGENT SKILLS (mandatory)\n'
      + 'Before replying, scan this skill index. If any saved skill is even partly relevant, call skill.view with its name before acting. '
      + 'Do not infer the procedure from the summary alone; load the full body first. ' + manage + '\n\n';
    const tail = omitted ? ('\n\n(' + omitted + ' more saved skill' + (omitted === 1 ? ' was' : 's were') + ' omitted to keep the prompt lean.)') : '';
    return { text: head + parts.join('\n') + tail, ids, omitted };
  }

  return { composeIndex };
});
