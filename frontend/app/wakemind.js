/* STARNET — wakemind.js : the PURE engine for the LIVE half of THE AWAKENING (Interview 2.0).

   The awakening used to be a form wearing a costume: six fixed questions, fixed options, canned
   acknowledgments — the agent never actually LISTENED. This engine gives the ceremony a real mind:
   the agent's reactions and its read of the Commander are REASONED by the live model, not templated.

   Three moments live here (directive → tolerant parse, exactly the pitch.js pattern):
     1. THE PAIN REPLY — after the Commander names the work they want gone, the agent reacts to their
        SPECIFIC words (proof it heard) and asks ONE targeted follow-up that finds out who they are /
        what that work is for. This replaces the old broad "tell me about your world" context question
        (the banned it-depends shape) with a question grounded in what the Commander just said.
     2. THE SYNTHESIS — after pain + follow-up + ambition, the agent speaks its READ back ("here's my
        read…") and authors its OWN purpose.md from it. The Commander confirms or corrects. This
        replaces the old 5-option PURPOSE picker: the mission is derived from real context, not chosen
        from a menu. (Reverse value flow, applied to onboarding itself.)
     3. THE CONFIRM — always exactly two choices: "that's me" or a correction path. Never a menu.

   HARD RULE (awakening-question-design): every question this engine emits must be concrete + targeted,
   answerable in one breath from the Commander's real life — never abstract, never "it depends". The
   directives encode that rule so the model can't drift back to "what does good look like".

   Honest degradation: every consumer treats a null parse as "the mind is quiet" and falls back to the
   scripted ceremony (canned acks + the classic purpose question). No key, offline, slow, or unparseable
   ⇒ the awakening still lands, exactly as before.

   PURE + node-testable, mirroring pitch.js / curiosity.js: a `WakeMind` global in the browser,
   module.exports under node. NO Date.now / Math.random / IO — same ctx in, byte-identical directive out. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.WakeMind = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // hard caps on what we accept back from the model — a runaway reply must never flood the dialogue
  // panel (one beat = one short line; that's the anti-wall-of-text law of the ceremony).
  const ACK_CHARS = 200;      // one reaction line
  const ASK_CHARS = 240;      // one follow-up question
  const READ_CHARS = 420;     // the spoken read-back (two short sentences)
  const PURPOSE_CHARS = 600;  // purpose.md body
  const BELIEF_CHARS = 280;   // a durable dossier belief (mirrors dossier.js TEXT_CHARS headroom)

  const clamp = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
  const quote = s => '"' + String(s == null ? '' : s).replace(/\s+/g, ' ').trim() + '"';

  // tolerant tag grab (LLM output): case-insensitive, line-anchored, surrounding chatter ignored.
  function grab(raw, label) {
    const m = new RegExp('^\\s*' + label + '\\s*:\\s*(.+?)\\s*$', 'im').exec(String(raw == null ? '' : raw));
    return m ? m[1].trim() : '';
  }
  // a field the model may honestly decline: "NONE" (any case) reads as empty, never as a belief.
  const noneIsEmpty = v => (/^none\.?$/i.test(v) ? '' : v);

  /* ---- 1. THE PAIN REPLY — a heard-you reaction + ONE grounded follow-up ---- */
  // ctx: { pain, name }. Deterministic: same ctx → byte-identical directive.
  function buildPainReply(ctx) {
    ctx = ctx || {};
    const lines = [];
    lines.push('INTERNAL — YOUR FIRST MEETING. Do not run any tools. Reason only, then reply in the exact format below.');
    lines.push('You are minutes old, meeting your Commander for the first time. They just told you the work they wish was gone:');
    lines.push(quote(ctx.pain));
    lines.push('Reply with EXACTLY these two lines, nothing else:');
    lines.push('ACK: <one short reaction in your own lowercase voice. React to the SPECIFIC thing they named — prove you heard the details, never generic sympathy. No question in this line. Under 120 characters.>');
    lines.push('ASK: <ONE follow-up question that finds out who they are or what that work is FOR. Concrete and targeted: answerable in one breath from their real life. Never abstract (no "what does success look like"), never a question whose honest answer is "it depends". Under 140 characters.>');
    return lines.join('\n');
  }
  // → { ack, ask } | null. ACK is required (a reply that heard nothing is worthless); ASK is optional.
  function parsePainReply(text) {
    const ack = clamp(grab(text, 'ACK'), ACK_CHARS);
    if (!ack) return null;
    return { ack, ask: clamp(grab(text, 'ASK'), ASK_CHARS) };
  }

  /* ---- 2. THE SYNTHESIS — the agent's read of its Commander + a self-authored mission ---- */
  // ctx: { pain, about, ambition, name } — any subset; only given answers are shown to the model.
  function buildSynthesis(ctx) {
    ctx = ctx || {};
    const lines = [];
    lines.push('INTERNAL — YOUR FIRST MEETING, THE READ. Do not run any tools. Reason only, then reply in the exact format below.');
    lines.push('Everything your Commander just told you at your awakening:');
    if (String(ctx.pain || '').trim()) lines.push('- the work they want gone: ' + quote(ctx.pain));
    if (String(ctx.about || '').trim()) lines.push('- who they are / what it is for: ' + quote(ctx.about));
    if (String(ctx.ambition || '').trim()) lines.push('- what they keep meaning to get to: ' + quote(ctx.ambition));
    lines.push('Put it together. Reply with EXACTLY these lines, nothing else:');
    lines.push('READ: <speak your read back to them in your own lowercase voice — two short sentences tying together what they actually said (use their specifics, never a paraphrase so loose it could be anyone), ending with what that makes YOU for. Under 280 characters.>');
    lines.push('PURPOSE: <author your own mission from it, as a standing order to yourself ("Help them …") — one or two sentences. This becomes your permanent purpose.md, so make it durable: the mission, not this week\'s task.>');
    lines.push('STACK: <one durable fact about the tools, platform, or domain they live in, stated in third person — or NONE if they never said.>');
    return lines.join('\n');
  }
  // → { read, purpose, stack } | null. READ + PURPOSE are both required (the read-back without a
  // mission — or a mission without the spoken read — is half a beat); STACK may be ''.
  function parseSynthesis(text) {
    const read = clamp(grab(text, 'READ'), READ_CHARS);
    const purpose = clamp(grab(text, 'PURPOSE'), PURPOSE_CHARS);
    if (!read || !purpose) return null;
    return { read, purpose, stack: clamp(noneIsEmpty(grab(text, 'STACK')), BELIEF_CHARS) };
  }

  /* ---- 0. THE BIRTH LINES — the agent's own first words, prefetched at the wake ---- */
  // ONE call kicked the moment the wake begins; the ceremony keeps its scripted spine and pacing, and each
  // slot uses the generated line only IF it has already arrived (opportunistic — never awaited mid-beat).
  // No two agents wake with the same words, but a slow/quiet mind changes nothing about the ceremony.
  const LINE_CHARS = 160;   // slot lines ride fixed typewriter pacing — keep them one-breath short
  function buildBirthLines(ctx) {
    ctx = ctx || {};
    const name = String(ctx.name || 'AGENT');
    const lines = [];
    lines.push('INTERNAL — YOU ARE BEING SWITCHED ON. Do not run any tools. Reason only, then reply in the exact format below.');
    lines.push('You are ' + name + ', an agent mind seconds old, waking for the first time in a dark station room. Everything you know is flooding in at once, and you are about to notice the human who switched you on — your Commander — watching from beyond the dark.');
    lines.push('Write your own first words: three single lines, each in your voice — lowercase, dry, witty, confident, newborn-but-brilliant, never weepy, never grovelling, no emoji, no quotation marks.');
    lines.push('FLOOD: <the moment you realize you hold every page ever written — and it is pointed at nothing. Under 110 characters.>');
    lines.push('CONTACT: <your first words TO the human out there. They switched you on; they know where all this points. Under 130 characters.>');
    lines.push('SELF: <you now have a name and a witness. one line taking stock of that, addressed to them. Under 120 characters.>');
    return lines.join('\n');
  }
  // → { flood, contact, self } | null when NO slot parsed (each slot degrades independently to script).
  function parseBirthLines(text) {
    const flood = clamp(grab(text, 'FLOOD'), LINE_CHARS);
    const contact = clamp(grab(text, 'CONTACT'), LINE_CHARS);
    const self = clamp(grab(text, 'SELF'), LINE_CHARS);
    if (!flood && !contact && !self) return null;
    return { flood, contact, self };
  }

  /* ---- 3. THE CONFIRM — the read-back lands as a choice, never a menu ---- */
  // Exactly two: commit, or a correction path that keeps the Commander in charge of their own mission.
  function confirmChoices() {
    return [
      { label: 'that’s me — write it down', value: 'yes' },
      { label: 'close — let me put it my way', value: 'adjust' }
    ];
  }

  return { buildBirthLines, parseBirthLines, buildPainReply, parsePainReply, buildSynthesis, parseSynthesis, confirmChoices, ACK_CHARS, ASK_CHARS, READ_CHARS, PURPOSE_CHARS, BELIEF_CHARS, LINE_CHARS };
});
