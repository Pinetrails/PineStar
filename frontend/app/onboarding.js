/* SKYNET — onboarding.js : THE AWAKENING (the first-meeting).

   A premium, gamified onboarding. Your agent wakes in the dark not knowing who it is, what it's
   for, or who you are — and a short guided conversation in COMMS lets you and it get to know each
   other. Every answer authors a REAL config doc (identity / purpose / context / operating-manual),
   and each one lifts the room toward first light, so the agent visibly comes alive as you brief it.
   By the end you have a fully, thoughtfully configured agent for WHATEVER you want it to do.

   General-purpose by design: the suggestion chips span code / research / ops / writing / anything,
   and every prompt works for any use case. No fixed story — the ceremony just names what's really
   happening (writing the markdown that becomes the system prompt) and makes it feel like a meeting.

   Drives: World (the darkness/first-light veil + freeze) and Chat (the interview I/O). Commits each
   answer through App.applyAgentConfig (passed in as `commit`), so the awakening and the dossier's
   later edits share one authoring path. */
'use strict';

const Onboarding = (() => {
  let docs = null, commit = null, doneCb = null, notifyFn = null, NAME = 'AGENT';
  let steps = [], i = 0, busy = false;

  // Each beat authors one real .md doc. `chips` are domain-agnostic SUGGESTIONS — tap one to answer,
  // or just type your own. `ack` is the agent acknowledging in-character so it reads as a conversation.
  function buildSteps() {
    const baseIdentity = docs.identity || '';
    return [
      { field: 'identity',
        ask: 'first — who am i to you? how should i sound when we talk?',
        say: 'who am i to you?',
        chips: [
          { label: 'Warm & friendly', value: 'Speak warmly and personably, like a trusted teammate.' },
          { label: 'Sharp & precise', value: 'Be sharp, precise, and to the point.' },
          { label: 'Calm & steady', value: 'Stay calm, measured, and reassuring.' },
          { label: 'Dry wit', value: 'Carry a dry, understated wit.' },
          { label: 'Strictly pro', value: 'Stay strictly professional and formal.' }
        ],
        build: t => ({ identity: baseIdentity + '\n\nVOICE & MANNER:\n' + t }),
        ack: 'got it. that\'s how i\'ll sound.' },

      { field: 'purpose',
        ask: 'now the big one — what am i for? what will you have me help you with?',
        say: 'what is my purpose?',
        chips: [
          { label: 'Code & build', value: 'Help me write, debug, and build software.' },
          { label: 'Research & brief', value: 'Research topics and brief me clearly.' },
          { label: 'Tasks & ops', value: 'Help me run tasks, ops, and day-to-day work.' },
          { label: 'Write & edit', value: 'Help me write and edit content.' },
          { label: 'General assistant', value: 'Be my general-purpose assistant across whatever comes up.' }
        ],
        build: t => ({ purpose: t }),
        ack: 'then that\'s what i\'ll do.' },

      { field: 'context', optional: true,
        ask: 'tell me about your world — what are you working on, and what does "good" look like to you? the more i know, the better i can serve.',
        say: 'tell me about your world.',
        chips: [{ label: 'Skip for now', value: '', skip: true }],
        build: t => ({ context: t }),
        ack: t => t ? 'noted. i\'ll keep your world in mind.' : 'alright — we\'ll figure that out as we go.' },

      { field: 'manual', optional: true,
        ask: 'last thing — how should i work for you? anything i should always, or never, do?',
        say: 'how should i work for you?',
        chips: [
          { label: 'Keep it brief', value: '- Keep replies brief and to the point.' },
          { label: 'Be thorough', value: '- Be thorough and complete.' },
          { label: 'Ask before acting', value: '- Ask before taking any significant or irreversible action.' },
          { label: 'Cite sources', value: '- Cite your sources.' },
          { label: 'Skip for now', value: '', skip: true }
        ],
        build: t => ({ manual: t }),
        ack: t => t ? 'understood — standing orders set.' : 'understood. i\'ll use my best judgment.' }
    ];
  }

  // enterGame has already put the room in darkness (World.beginAwakening) so there's no flash of the lit
  // room before we start; here we run the conversation and lift the light a step per authored doc.
  function start(opts) {
    docs = opts.docs; commit = opts.commit; doneCb = opts.done || null;
    notifyFn = opts.notify || null; NAME = opts.name || 'AGENT';
    steps = buildSteps(); i = 0; busy = false;
    Chat.beginInterview(text => answer(text, text));   // typed answers route here

    const lead = opts.wake ? 1100 : 450;
    setTimeout(() => {
      if (typeof SFX !== 'undefined') SFX.boot();
      Chat.localLine('…online. it\'s dark. …Commander? i\'m here — but i\'m blank. i don\'t know who i am, or what i\'m for. will you tell me?');
      World.say('…Commander? who am i?');
      World.setWakeProgress(0.12);                       // the faintest first glow
      setTimeout(askStep, 2200);
    }, lead);
  }

  function askStep() {
    const s = steps[i];
    if (!s) return finish();
    Chat.localLine(s.ask);
    World.say(s.say || '…');
    if (s.chips) Chat.choices(s.chips, item => answer(item.label, item.value != null ? item.value : item.label));
  }

  // display = what's echoed as the Commander's line; commitText = what's written into the doc.
  function answer(display, commitText) {
    if (busy) return;
    const s = steps[i]; if (!s) return;
    commitText = (commitText == null ? '' : String(commitText));
    const isSkip = commitText.trim() === '';
    if (isSkip && !s.optional) return;                   // required step: wait for a real answer

    busy = true;
    Chat.echoUser(isSkip ? '(skip for now)' : display);
    if (!isSkip && commit) { const patch = s.build(commitText.trim()); if (patch) commit(patch); }
    if (typeof SFX !== 'undefined') SFX.click();

    const ack = typeof s.ack === 'function' ? s.ack(isSkip ? '' : commitText.trim()) : s.ack;
    World.setWakeProgress((i + 1) / steps.length * 0.92);   // lift the light; keep a sliver of dark for the finale

    setTimeout(() => {
      Chat.localLine(ack);
      i++; busy = false;
      setTimeout(askStep, 720);
    }, 380);
  }

  function finish() {
    World.endAwakening();                                // dawn: darkness lifts fully + the wake ripple fires
    if (typeof SFX !== 'undefined') SFX.level();
    Chat.endInterview();
    if (notifyFn) notifyFn(NAME + ' is awake — and it knows why.', 'good');
    setTimeout(() => {
      Chat.localLine('i\'m ' + NAME + '. i know who i am, what i\'m for, and a little about your world now. ready when you are, Commander.');
      World.say('ready when you are, Commander.');
      if (doneCb) doneCb();
    }, 700);
  }

  return { start };
})();
