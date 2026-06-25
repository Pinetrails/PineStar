/* STARNET — sim.js : simulation engine. tasks, pipelines, economy, feedback, ultron brain */
'use strict';

const SIM = (() => {
  const bus = U.bus;
  let S = null;

  /* ================= STATE ================= */
  function newState() {
    const agents = {};
    DATA.AGENTS.forEach(a => {
      agents[a.id] = {
        skill: a.skill, morale: 72, autonomy: a.autonomy, reliability: a.reliability,
        xp: 0, level: 1, tasksDone: 0, earned: 0, spent: 0, fbApproved: 0, fbDenied: 0,
        taskId: null, statusTxt: 'booting harness…'
      };
    });
    return {
      v: 1, time: 7 * 60, // day 1, 07:00
      mode: 'MANUAL', party: 0,
      rev: { total: 0, etsy: 0, fiverr: 0, other: 0 }, costs: 0,
      level: 1, xp: 0,
      agents, tasks: [], feedback: [], notifs: [], ops: [], chat: [], archives: [],
      objectives: [], counters: {}, milestones: [],
      listings: { etsy1: 0, etsy2: 0, etsy3: 0, assets: 0, articles: 0, songs: 0 },
      insights: { etsy1: 1, etsy2: 1, etsy3: 1, saas: 0 },
      saasProjects: [], mrr: 0,
      pivots: {}, // store -> boostUntil(time)
      fiverrRating: 4.6,
      history: [], // per day {day, rev, costs, sales, tasks}
      dayAcc: { rev: 0, costs: 0, sales: 0, tasks: 0 },
      gen: {}, ultronQueue: [], stats: { totalTasks: 0, totalSales: 0, fb: 0 },
      hazardSeq: 0,
      shipQueue: [], // deliverables being hand-carried to HERALD by their maker

      kindStats: {} // per deliverable kind: production / sales / quality telemetry
    };
  }

  /* per-kind production & sales telemetry (lazy-create keeps old saves valid) */
  function KS(kind) {
    const all = S.kindStats || (S.kindStats = {});
    return all[kind] || (all[kind] = {
      made: 0, madeToday: 0, shipped: 0, shippedToday: 0,
      sold: 0, soldToday: 0, rev: 0, revToday: 0,
      qSum: 0, qN: 0, bestQ: 0, lastSaleT: 0, lastShipT: 0
    });
  }

  /* ================= LOGGING ================= */
  function ops(txt, cls) {
    S.ops.push({ t: S.time, txt, cls: cls || '' });
    if (S.ops.length > 140) S.ops.splice(0, S.ops.length - 140);
    bus.emit('ops');
  }
  function chat(from, txt) {
    S.chat.push({ t: S.time, from, txt });
    if (S.chat.length > 160) S.chat.splice(0, S.chat.length - 160);
    bus.emit('chat', { from, txt });
  }
  function notify(txt, cls) {
    S.notifs.push({ t: S.time, txt, cls: cls || '', read: false });
    if (S.notifs.length > 80) S.notifs.splice(0, S.notifs.length - 80);
    bus.emit('notify', txt);
  }
  function archive(kind, txt) {
    S.archives.push({ t: S.time, kind, txt });
    if (S.archives.length > 200) S.archives.splice(0, S.archives.length - 200);
  }

  /* ================= LEVEL / PERKS ================= */
  const xpNext = lvl => Math.round(120 * Math.pow(lvl, 1.35));
  function addXp(n) {
    S.xp += Math.round(n);
    while (S.xp >= xpNext(S.level)) {
      S.xp -= xpNext(S.level); S.level++;
      notify('STATION LEVEL UP → ' + S.level, 'good');
      chat('ULTRON', 'Station level ' + S.level + ' achieved. ' + (perkAt(S.level) ? 'Perk online: ' + perkAt(S.level).name + ' — ' + perkAt(S.level).desc : 'Standards rise accordingly.'));
      if (S.level >= 8) DATA.AGENTS.forEach(a => { if (perkAt(8) && S.level === 8) S.agents[a.id].autonomy = U.clamp(S.agents[a.id].autonomy + 10, 0, 96); });
      bus.emit('level');
      SFX.level();
    }
    bus.emit('stats');
  }
  const perkAt = lvl => DATA.C.perks.find(p => p.lvl === lvl);
  const hasPerk = lvl => S.level >= lvl;
  const speedMult = () => 1 + (hasPerk(2) ? 0.08 : 0);
  const qualBonus = () => (hasPerk(4) ? 4 : 0);
  const saleMult = () => (hasPerk(3) ? 1.12 : 1) * (hasPerk(5) ? 1.10 : 1) * (hasPerk(12) ? 1.20 : 1);
  const revMult = () => (hasPerk(5) ? 1.10 : 1);
  const costMult = () => (hasPerk(6) ? 0.85 : 1) * (hasPerk(12) ? 0.90 : 1);

  /* ================= MILESTONES / OBJECTIVES ================= */
  function unlock(id) {
    if (S.milestones.includes(id)) return;
    const m = DATA.C.milestones.find(m => m.id === id); if (!m) return;
    S.milestones.push(id);
    notify('MILESTONE: ' + m.name + ' — ' + m.desc, 'gold');
    ops('★ MILESTONE UNLOCKED: ' + m.name, 'gold');
    addXp(m.xp);
  }
  function checkMilestones() {
    const r = S.rev.total;
    if (S.stats.totalSales >= 1) unlock('first_sale');
    if (r >= 100) unlock('rev_100'); if (r >= 1000) unlock('rev_1k'); if (r >= 10000) unlock('rev_10k');
    const tt = S.stats.totalTasks;
    if (tt >= 10) unlock('tasks_10'); if (tt >= 50) unlock('tasks_50'); if (tt >= 200) unlock('tasks_200');
    if (S.listings.etsy1 + S.listings.etsy2 + S.listings.etsy3 + S.listings.assets >= 25) unlock('listings_25');
    if (S.stats.fb >= 25) unlock('fb_25');
    if (DATA.AGENTS.some(a => a.id !== 'ULTRON' && S.agents[a.id].autonomy >= 80)) unlock('autonomy_80');
    if (Math.floor(S.time / 1440) + 1 >= 7) unlock('day_7');
  }

  function rollObjectives() {
    const pool = [...DATA.C.objectives];
    S.objectives = [];
    for (let i = 0; i < 3; i++) {
      const o = pool.splice(U.irnd(0, pool.length - 1), 1)[0];
      const n = U.irnd(o.n[0], o.n[1]);
      S.objectives.push({ key: o.key, txt: o.txt.replace('{n}', n), target: n, prog: 0, done: false });
    }
    S.counters = {};
    bus.emit('objectives');
  }
  function inc(key, n) {
    S.counters[key] = (S.counters[key] || 0) + (n || 1);
    let hit = false;
    S.objectives.forEach(o => {
      if (o.key === key && !o.done) {
        o.prog = Math.min(o.target, o.prog + (n || 1));
        if (o.prog >= o.target) { o.done = true; hit = true; addXp(60); notify('OBJECTIVE COMPLETE: ' + o.txt, 'good'); }
      }
    });
    if (hit) SFX.notify();
    bus.emit('objectives');
  }

  /* ================= TASKS ================= */
  function mkTask(o) {
    const t = Object.assign({
      id: U.id(), status: 'todo', prog: 0, createdT: S.time,
      dur: 30, quality: null, playerOrder: false, note: null
    }, o);
    S.tasks.push(t);
    if (S.tasks.length > 260) {
      const doneIdx = S.tasks.findIndex(x => x.status === 'done' || x.status === 'failed');
      if (doneIdx >= 0) S.tasks.splice(doneIdx, 1);
    }
    bus.emit('task', t);
    return t;
  }

  function agentRoom(id) { return DATA.AGENT[id].room; }

  function taskCost(agentId) {
    const m = DATA.MODELS[DATA.AGENT[agentId].model];
    return U.rnd(m.costMin, m.costMax) * costMult();
  }

  function rollQuality(agentId, t) {
    const ag = S.agents[agentId];
    let q = 32 + ag.skill * 0.55 + (ag.morale - 60) * 0.18 + U.rnd(-13, 13) + qualBonus();
    if (t.retried) q += 9;
    if (t.note) q += 4;
    if (t.rushPenalty) q -= t.rushPenalty * 7;
    if (ag.morale < 40) q -= 9;
    return Math.round(U.clamp(q, 15, 99));
  }
  // confidence threshold: below this quality the agent flags for player review
  const flagBelow = agentId => Math.round(76 - S.agents[agentId].autonomy * 0.38);

  const FLAGGABLE = ['apparel', 'candle', 'custom', 'fiverr', 'assets', 'article', 'song', 'saas', 'pivot'];

  function completeTask(t) {
    const ag = S.agents[t.agentId];
    const cost = taskCost(t.agentId);
    S.costs += cost; ag.spent += cost; S.dayAcc.costs += cost;
    t.quality = rollQuality(t.agentId, t);

    // commander-flagged jobs always stop for review — ANY kind; the Commander's flag outranks the pipeline
    if (t.flagReview && !t.approvedByPlayer) {
      t.status = 'review'; ag.taskId = null;
      S.feedback.push({ id: U.id(), taskId: t.id, agentId: t.agentId, t: S.time, title: t.title, kind: t.kind, quality: t.quality, msg: 'Commander requested personal review — Q' + t.quality + ' logged.', status: 'open' });
      ops('⚑ ' + t.agentId + ' ▸ "' + short(t.title) + '" held for Commander review [Q' + t.quality + ']', 'warn');
      notify(t.agentId + ' ▸ flagged work ready: ' + short(t.title), 'warn');
      bus.emit('feedback'); bus.emit('hazard'); bus.emit('flagged', { agentId: t.agentId }); SFX.notify(); return;
    }

    if (FLAGGABLE.includes(t.kind) && t.quality < flagBelow(t.agentId) && !t.approvedByPlayer) {
      t.status = 'review';
      ag.taskId = null;
      const thing = DATA.KINDS[t.kind].label.toLowerCase();
      const doubt = U.pick(DATA.C.selfdoubt).replace('{thing}', thing); // one roll — chat must match the queue card
      S.feedback.push({
        id: U.id(), taskId: t.id, agentId: t.agentId, t: S.time,
        title: t.title, kind: t.kind, quality: t.quality,
        msg: doubt,
        status: 'open'
      });
      ops('⚠ ' + t.agentId + ' flagged "' + short(t.title) + '" for Commander review', 'warn');
      chat(t.agentId, '@COMMANDER ' + doubt);
      notify(t.agentId + ' needs your review: ' + short(t.title), 'warn');
      bus.emit('feedback'); bus.emit('hazard'); bus.emit('flagged', { agentId: t.agentId });
      SFX.notify();
      return;
    }
    finalize(t);
  }

  function short(s) { return s.length > 44 ? s.slice(0, 42) + '…' : s; }

  function finalize(t) {
    const ag = S.agents[t.agentId];
    t.status = 'done'; t.doneT = S.time;
    if (ag.taskId === t.id) ag.taskId = null;
    ag.tasksDone++; ag.xp += 10;
    if (ag.xp >= ag.level * 60) {
      ag.xp = 0; ag.level++; ag.skill = U.clamp(ag.skill + 1.5, 0, 97);
      ops('▲ ' + t.agentId + ' reached LVL ' + ag.level, 'good');
      if (U.chance(0.7)) chat(t.agentId, U.pick([
        'LVL ' + ag.level + '. the harness hums a little smoother.',
        'rank up. context feels roomier already.',
        'LVL ' + ag.level + ' — @COMMANDER the training is landing.'
      ]));
      bus.emit('agentlevel', { agentId: t.agentId, level: ag.level });
    }
    S.stats.totalTasks++; S.dayAcc.tasks++;
    const ks = KS(t.kind);
    ks.made++; ks.madeToday++;
    if (t.quality != null) { ks.qSum += t.quality; ks.qN++; if (t.quality > ks.bestQ) ks.bestQ = t.quality; }
    inc('tasks'); addXp(8);
    if (hasPerk(10) && U.chance(0.06)) { ag.skill = U.clamp(ag.skill + 1, 0, 97); chat(t.agentId, 'ran a self-eval loop. found a better prompt pattern. logged it with @SCRIBE'); }

    switch (t.kind) {
      case 'research': {
        S.insights[t.target] = (S.insights[t.target] || 0) + 1;
        inc('research');
        ops(t.agentId + ' filed research: ' + short(t.flavor || t.title));
        if (U.chance(0.6)) {
          const dest = { etsy1: 'FORGE', etsy2: 'VECTOR', etsy3: 'PROMETHEUS', saas: 'CIPHER' }[t.target];
          if (dest) {
            chat(t.agentId, '@' + dest + ' fresh intel: ' + (t.flavor || 'new angle filed') + '. build on it.');
            bus.emit('intel', { agentId: t.agentId, dest }); // researcher walks over to brief them
          }
        }
        break;
      }
      case 'apparel': case 'candle': case 'custom': case 'assets': case 'song': case 'article': {
        ops(t.agentId + ' finished ' + DATA.KINDS[t.kind].label + ': ' + short(t.flavor || t.title), 'good');
        // the maker hand-carries this to HERALD: belt drop, then publishing room.
        // WORLD walks the body and calls heraldHandoff on arrival; minuteTick
        // flushes overdue ships so a reload or party can never lose a publish.
        const ship = {
          id: U.id(), agentId: t.agentId, room: agentRoom(t.agentId),
          kind: t.kind, payloadQ: t.quality, flavor: t.flavor, title: t.title,
          // due scales with sim speed: the carrier walks in real time, the clock doesn't
          due: S.time + 45 * ((typeof GAME !== 'undefined' && GAME.settings && GAME.settings.speed) || 1)
        };
        (S.shipQueue = S.shipQueue || []).push(ship);
        bus.emit('deliverable', ship);
        break;
      }
      case 'publish': {
        const pk = t.payloadKind;
        const storeKey = DATA.KINDS[pk] && DATA.KINDS[pk].store;
        if (storeKey) S.listings[storeKey]++;
        else if (pk === 'assets') S.listings.assets++;
        else if (pk === 'article') { S.listings.articles++; inc('articles'); }
        else if (pk === 'song') { S.listings.songs++; inc('songs'); }
        if (storeKey || pk === 'assets') inc('listings');
        if (pk) { const kp = KS(pk); kp.shipped++; kp.shippedToday++; kp.lastShipT = S.time; }
        ops('HERALD published "' + short(t.flavor || t.title) + '" → calendar slot confirmed', 'good');
        if (U.chance(0.3)) chat('HERALD', 'shipped "' + short(t.flavor || '') + '". calendar holds. next.');
        break;
      }
      case 'fiverr': {
        const amt = U.rnd(15, 60) * (t.quality / 70) * revMult();
        earn(amt, 'fiverr', 'PIXEL');
        const kf = KS('fiverr'); kf.sold++; kf.soldToday++; kf.rev += amt; kf.revToday += amt; kf.lastSaleT = S.time;
        inc('fiverr');
        S.fiverrRating = U.clamp(S.fiverrRating + (t.quality >= 70 ? 0.02 : -0.08), 3.2, 5);
        ops('PIXEL delivered Fiverr order (+' + U.money(amt) + ', ★' + S.fiverrRating.toFixed(1) + ')', 'good');
        break;
      }
      case 'saas': {
        const proj = S.saasProjects.find(p => p.id === t.projId);
        if (proj) {
          proj.stage++;
          if (proj.stage >= 3) {
            proj.live = true;
            const m = U.rnd(18, 60);
            proj.mrr = m; S.mrr += m;
            unlock('first_mrr');
            ops('CIPHER launched ' + proj.name + ' — MRR ' + U.money(m) + '/day', 'gold');
            chat('CIPHER', proj.name + ' is LIVE. first users in. @LEDGER start a new revenue line. @QUILL I need an article.');
            notify('SAAS LAUNCHED: ' + proj.name, 'gold');
          } else {
            ops('CIPHER completed build stage ' + proj.stage + '/3 of ' + proj.name);
            mkTask({ kind: 'saas', agentId: 'CIPHER', title: proj.name + ' — build stage ' + (proj.stage + 1) + '/3', dur: U.irnd(70, 110), projId: proj.id, flavor: proj.name });
          }
        }
        break;
      }
      case 'pivot': {
        S.pivots[t.target] = S.time + 2880; // 2-day boost
        unlock('first_pivot');
        inc('hazards');
        ops('⚑ PIVOT EXECUTED on ' + t.flavor + ' — new strategy live', 'gold');
        chat('ATHENA', 'pivot deployed on ' + t.flavor + '. @RAVEN watch the curve. everyone else: new playbook is in @SCRIBE\'s archive.');
        break;
      }
      case 'finance': ops('LEDGER posted the daily P&L to the treasury board'); break;
      case 'strategy': ops(t.agentId + ' completed strategy review — all lines assessed'); break;
      case 'comms': ops('RELAY digested inbound comms — Commander inbox is clean'); break;
      case 'archive': ops('SCRIBE consolidated station context into the Archives'); break;
      case 'directive': ops(t.agentId + ' executed Commander directive: ' + short(t.title), 'good'); break;
    }

    if (t.playerOrder) ultronVerify(t);
    bus.emit('task', t); bus.emit('stats');
    checkMilestones();
  }

  /* the maker reached HERALD's desk (or the fallback timer fired):
     the publish task exists from this moment. idempotent per ship id. */
  function heraldHandoff(shipId) {
    const q = S.shipQueue = S.shipQueue || [];
    const i = q.findIndex(s => s.id === shipId);
    if (i < 0) return false;
    const ship = q.splice(i, 1)[0];
    mkTask({
      kind: 'publish', agentId: 'HERALD', title: 'Publish: ' + (ship.flavor || ship.title),
      dur: U.irnd(8, 16), payloadKind: ship.kind, payloadQ: ship.payloadQ, flavor: ship.flavor
    });
    ops(ship.agentId + ' handed "' + short(ship.flavor || ship.title) + '" to HERALD for publishing');
    return true;
  }

  function earn(amt, channel, agentId) {
    amt = Math.round(amt * 100) / 100;
    S.rev.total += amt; S.rev[channel] = (S.rev[channel] || 0) + amt;
    S.dayAcc.rev += amt;
    if (agentId && S.agents[agentId]) S.agents[agentId].earned += amt;
    bus.emit('stats');
  }

  function ultronVerify(t) {
    const ok = t.quality >= 62;
    const pool = ok ? DATA.C.ultron_verify_ok : DATA.C.ultron_verify_bad;
    queueUltron(U.pick(pool).replace('{agent}', t.agentId).replace('{q}', t.quality), 2);
    if (!ok && !t.reworked) {
      const re = mkTask({ kind: t.kind === 'directive' ? 'directive' : t.kind, agentId: t.agentId, title: 'REWORK: ' + t.title, dur: Math.round(t.dur * 0.7), playerOrder: true, retried: true, reworked: true, flavor: t.flavor, target: t.target });
      re.note = 'ULTRON demanded rework';
    }
  }
  function queueUltron(txt, delay) { S.ultronQueue.push({ due: S.time + (delay || 1), txt }); }

  /* ================= SALES ================= */
  function salesTick() {
    const stores = [
      { key: 'etsy1', kind: 'apparel', agent: 'FORGE' },
      { key: 'etsy2', kind: 'candle', agent: 'VECTOR' },
      { key: 'etsy3', kind: 'custom', agent: 'PROMETHEUS' }
    ];
    for (const st of stores) {
      const L = S.listings[st.key]; if (!L) continue;
      const ag = S.agents[st.agent];
      const boost = (S.pivots[st.key] && S.pivots[st.key] > S.time) ? 1.6 : 1;
      const p = Math.min(L, 14) * 0.00040 * (ag.skill / 60) * saleMult() * boost;
      if (U.chance(p)) {
        const [a, b] = DATA.KINDS[st.kind].rev;
        const amt = U.rnd(a, b) * revMult();
        earn(amt, 'etsy', st.agent);
        S.stats.totalSales++; S.dayAcc.sales++;
        const kst = KS(st.kind); kst.sold++; kst.soldToday++; kst.rev += amt; kst.revToday += amt; kst.lastSaleT = S.time;
        inc('sales');
        ops('◆ SALE: ' + DATA.KINDS[st.kind].label + ' +' + U.money(amt) + ' (' + st.agent + '\'s store)', 'sale');
        if (U.chance(0.22)) chat(st.agent, 'cha-ching. ' + U.money(amt) + ' on the ' + st.kind + ' line. the research holds up @NOVA');
        bus.emit('sale', { amt, agentId: st.agent, kind: st.kind }); SFX.sale();
        checkMilestones();
      }
    }
    if (S.listings.assets && U.chance(Math.min(S.listings.assets, 10) * 0.00013)) {
      const amt = U.rnd(9, 29) * revMult(); earn(amt, 'other', 'ATLAS'); S.stats.totalSales++; S.dayAcc.sales++; inc('sales');
      const ka = KS('assets'); ka.sold++; ka.soldToday++; ka.rev += amt; ka.revToday += amt; ka.lastSaleT = S.time;
      ops('◆ SALE: asset bundle +' + U.money(amt) + ' (indie marketplace)', 'sale'); bus.emit('sale', { amt, agentId: 'ATLAS', kind: 'assets' }); SFX.sale();
    }
    if (S.listings.articles && U.chance(Math.min(S.listings.articles, 12) * 0.00022)) {
      const amt = U.rnd(3, 22) * revMult(); earn(amt, 'other', 'QUILL'); S.dayAcc.sales++;
      const kr = KS('article'); kr.sold++; kr.soldToday++; kr.rev += amt; kr.revToday += amt; kr.lastSaleT = S.time;
      ops('◆ COMMISSION: affiliate click-through +' + U.money(amt), 'sale'); bus.emit('sale', { amt, agentId: 'QUILL', kind: 'article' });
    }
    if (S.listings.songs && U.chance(Math.min(S.listings.songs, 10) * 0.0004)) {
      const amt = U.rnd(0.4, 3.2) * revMult(); earn(amt, 'other', 'VYBES');
      const km = KS('song'); km.sold++; km.soldToday++; km.rev += amt; km.revToday += amt; km.lastSaleT = S.time;
      ops('◆ ROYALTY: YouTube ad rev +' + U.money(amt), 'sale'); bus.emit('sale', { amt, agentId: 'VYBES', kind: 'song' });
    }
  }

  /* ================= GENERATORS (pipelines) ================= */
  function genReady(id, cd) {
    if (!S.gen[id]) { S.gen[id] = S.time + U.irnd(2, Math.max(3, cd / 3)); return false; }
    if (S.time >= S.gen[id]) { S.gen[id] = S.time + Math.round(cd * U.rnd(0.8, 1.25)); return true; }
    return false;
  }
  function agentFree(id) {
    const ag = S.agents[id];
    if (ag.taskId) return false;
    return !S.tasks.some(t => t.agentId === id && t.status === 'todo');
  }

  function generators() {
    // NOVA — store research rotation
    if (genReady('nova', 75) && agentFree('NOVA')) {
      const target = U.pick(['etsy1', 'etsy2', 'etsy3']);
      const flavor = U.pick(DATA.C.research);
      mkTask({ kind: 'research', agentId: 'NOVA', title: 'Deep-scan Etsy winners (' + { etsy1: 'apparel', etsy2: 'candles', etsy3: 'personalized' }[target] + ')', dur: U.irnd(34, 60), target, flavor });
    }
    // CURIE — trends + saas pain points
    if (genReady('curie', 95) && agentFree('CURIE')) {
      if (U.chance(0.4)) {
        const flavor = U.pick(DATA.C.painpoints);
        mkTask({ kind: 'research', agentId: 'CURIE', title: 'Mine pain points for SaaS leads', dur: U.irnd(40, 65), target: 'saas', flavor });
      } else {
        const target = U.pick(['etsy1', 'etsy2', 'etsy3']);
        mkTask({ kind: 'research', agentId: 'CURIE', title: 'Trend & SEO sweep', dur: U.irnd(35, 55), target, flavor: U.pick(DATA.C.research) });
      }
    }
    // FACTORY 1 — consume insights
    const f1 = [['FORGE', 'etsy1', 'apparel', DATA.C.apparel], ['VECTOR', 'etsy2', 'candle', DATA.C.candles], ['PROMETHEUS', 'etsy3', 'custom', null]];
    for (const [agId, store, kind, pool] of f1) {
      if (genReady(agId, 62) && agentFree(agId) && S.insights[store] > 0) {
        S.insights[store]--;
        let flavor;
        if (kind === 'custom') {
          flavor = U.pick(DATA.C.petstyles).replace('{pet}', U.pick(DATA.C.petnames));
        } else flavor = U.pick(pool);
        mkTask({ kind, agentId: agId, title: DATA.KINDS[kind].label + ': ' + flavor, dur: U.irnd(40, 70), flavor });
      }
    }
    // PIXEL — fiverr webhook orders
    if (genReady('fiverr', 120 - S.level * 3) ) {
      const brief = U.pick(DATA.C.fiverr);
      ops('⮞ FIVERR WEBHOOK: new order — ' + short(brief), 'warn');
      notify('Fiverr order in: ' + short(brief));
      mkTask({ kind: 'fiverr', agentId: 'PIXEL', title: 'Fiverr: ' + brief, dur: U.irnd(28, 48), flavor: brief });
      if (U.chance(0.3)) chat('PIXEL', 'webhook fired. "' + short(brief) + '". on it.');
    }
    // ATLAS — asset bundles
    if (genReady('atlas', 105) && agentFree('ATLAS')) {
      const flavor = U.pick(DATA.C.assets);
      mkTask({ kind: 'assets', agentId: 'ATLAS', title: 'PixelLab bundle: ' + flavor, dur: U.irnd(55, 85), flavor });
    }
    // QUILL — articles (plug pieces only run once their product actually exists)
    if (genReady('quill', 92) && agentFree('QUILL')) {
      const liveSaas = S.saasProjects.find(p => p.live);
      const pool = DATA.C.articles.filter(a =>
        (!a.includes('CIPHER') || liveSaas) &&
        (!a.includes('ATLAS') || S.listings.assets > 0) &&
        (!a.includes('VECTOR') || S.listings.etsy2 > 0));
      let flavor = U.pick(pool.length ? pool : DATA.C.articles);
      if (liveSaas) flavor = flavor.replace("CIPHER's app", liveSaas.name);
      mkTask({ kind: 'article', agentId: 'QUILL', title: 'Medium: ' + flavor, dur: U.irnd(45, 70), flavor });
    }
    // CIPHER — saas projects from research
    if (genReady('cipher', 130) && agentFree('CIPHER') && S.insights.saas > 0 && S.saasProjects.filter(p => !p.live).length === 0) {
      S.insights.saas--;
      const name = U.pick(DATA.C.saas.filter(s => !S.saasProjects.some(p => p.name === s)) .length ? DATA.C.saas.filter(s => !S.saasProjects.some(p => p.name === s)) : DATA.C.saas);
      const proj = { id: U.id(), name, stage: 0, live: false, mrr: 0 };
      S.saasProjects.push(proj);
      chat('CIPHER', 'greenlighting a build: ' + name + '. thank @CURIE for the lead.');
      mkTask({ kind: 'saas', agentId: 'CIPHER', title: name + ' — build stage 1/3', dur: U.irnd(70, 110), projId: proj.id, flavor: name });
    }
    // VYBES — songs
    if (genReady('vybes', 118) && agentFree('VYBES')) {
      const flavor = U.pick(DATA.C.songs);
      mkTask({ kind: 'song', agentId: 'VYBES', title: 'Suno session: ' + flavor, dur: U.irnd(50, 80), flavor });
    }
    // RELAY — comms digests
    if (genReady('relay', 200) && agentFree('RELAY'))
      mkTask({ kind: 'comms', agentId: 'RELAY', title: 'Cross-platform comms digest', dur: U.irnd(25, 45) });
    // SCRIBE — archive consolidation
    if (genReady('scribe', 240) && agentFree('SCRIBE'))
      mkTask({ kind: 'archive', agentId: 'SCRIBE', title: 'Consolidate station context', dur: U.irnd(30, 50) });
    // RAVEN — analytics passes
    if (genReady('raven', 180) && agentFree('RAVEN'))
      mkTask({ kind: 'strategy', agentId: 'RAVEN', title: 'Listing decay & conversion sweep', dur: U.irnd(35, 60) });
    // banter
    if (genReady('banter', 24)) {
      const [from, txt] = U.pick(DATA.C.banter);
      chat(from, txt);
    }
    if (genReady('flavor', 38)) ops(U.pick(DATA.C.ops_flavor), 'dim');
  }

  /* ================= PIVOT DETECTION ================= */
  function pivotCheck() {
    const stores = [['etsy1', 'FORGE', 'the apparel store'], ['etsy2', 'VECTOR', 'the candle store'], ['etsy3', 'PROMETHEUS', 'the personalized store']];
    for (const [key, agId, label] of stores) {
      if (S.listings[key] >= 6 && !(S.pivots[key] > S.time) && !S.tasks.some(t => t.kind === 'pivot' && t.target === key && (t.status === 'todo' || t.status === 'active' || t.status === 'review'))) {
        const ag = S.agents[agId];
        if (U.chance(0.10) && ag.skill < 80) {
          chat('RAVEN', '@ATHENA ' + label + ' conversion is drifting. -' + U.irnd(8, 22) + '% over 48h. this is the inflection.');
          chat('ATHENA', 'agreed. drafting a pivot for ' + label + '. @COMMANDER this will need your sign-off.');
          ops('⚑ WAR ROOM: pivot drafted for ' + label, 'warn');
          notify('War Room drafted a pivot for ' + label, 'warn');
          mkTask({ kind: 'pivot', agentId: 'ATHENA', title: 'PIVOT PLAN: ' + label, dur: U.irnd(60, 90), target: key, flavor: label });
        }
      }
    }
  }

  /* ================= FEEDBACK ================= */
  function feedback(fbId, verdict, note, opts) {
    const fb = S.feedback.find(f => f.id === fbId);
    if (!fb || fb.status !== 'open') return;
    const auto = !!(opts && opts.auto); // ULTRON's ruling, not the Commander's — trains less, builds no trust
    const t = S.tasks.find(x => x.id === fb.taskId);
    const ag = S.agents[fb.agentId];
    fb.status = verdict; fb.note = note || null;
    S.stats.fb++; inc('feedback'); inc('hazards');
    addXp(10);
    const noteBonus = note && note.length > 3 ? 1 : 0;
    if (noteBonus) { ag.skill = U.clamp(ag.skill + 1.2, 0, 97); ag.autonomy = U.clamp(ag.autonomy + 1.5, 0, 96); archive('feedback', 'Commander → ' + fb.agentId + ' [' + verdict.toUpperCase() + ']: ' + note); }
    else archive('feedback', 'Commander → ' + fb.agentId + ': ' + verdict.toUpperCase() + ' on "' + fb.title + '"');

    switch (verdict) {
      case 'approve':
        ag.fbApproved++; ag.morale = U.clamp(ag.morale + (auto ? 2 : 4), 0, 100);
        if (!auto) ag.autonomy = U.clamp(ag.autonomy + 2.5, 0, 96);
        ag.skill = U.clamp(ag.skill + (auto ? 0.4 : 0.8), 0, 97);
        if (t) { t.approvedByPlayer = true; t.quality = Math.max(t.quality, t.quality + 4); finalize(t); }
        ops('Commander APPROVED ' + fb.agentId + '\'s "' + short(fb.title) + '"', 'good');
        chat(fb.agentId, 'approval received. shipping it. thank you, @COMMANDER.');
        break;
      case 'deny':
        ag.fbDenied++; ag.morale = U.clamp(ag.morale - 6, 0, 100);
        ag.skill = U.clamp(ag.skill + 2, 0, 97); ag.autonomy = U.clamp(ag.autonomy - 1, 0, 96);
        if (t) { t.status = 'failed'; }
        ops('Commander DENIED ' + fb.agentId + '\'s "' + short(fb.title) + '"', 'bad');
        chat(fb.agentId, 'understood. it wasn\'t there yet. logging the lesson with @SCRIBE.');
        SFX.bad();
        break;
      case 'retry':
        ag.skill = U.clamp(ag.skill + (auto ? 0.5 : 1), 0, 97); ag.morale = U.clamp(ag.morale - 1, 0, 100);
        if (t) {
          t.status = 'failed';
          mkTask({ kind: t.kind, agentId: t.agentId, title: 'RETRY: ' + t.title.replace(/^RETRY: /, ''), dur: Math.round(t.dur * 0.75), retried: true, flavor: t.flavor, target: t.target, playerOrder: t.playerOrder, projId: t.projId, note });
        }
        ops('Commander ordered RETRY on "' + short(fb.title) + '"');
        chat(fb.agentId, 'rerolling with your notes. it\'ll be better.');
        break;
      case 'archive':
        ag.morale = U.clamp(ag.morale - 8, 0, 100); ag.skill = U.clamp(ag.skill + 0.5, 0, 97);
        if (t) t.status = 'failed';
        ops('Commander ARCHIVED "' + short(fb.title) + '" forever', 'dim');
        chat(fb.agentId, '…archived forever. noted. moving on.');
        archive('buried', fb.agentId + '\'s "' + fb.title + '" — archived forever by Commander order');
        break;
    }
    bus.emit('feedback'); bus.emit('hazard'); bus.emit('stats');
    checkMilestones();
  }

  /* ================= ULTRON BRAIN ================= */
  const INTENTS = [
    { rx: /(research|competitor|trend|intel|scan|find product)/, agent: 'NOVA', kind: 'research', mk: m => ({ target: U.pick(['etsy1', 'etsy2', 'etsy3']), flavor: U.pick(DATA.C.research) }) },
    { rx: /(apparel|shirt|tee|hoodie|sweat|clothing)/, agent: 'FORGE', kind: 'apparel', mk: () => ({ flavor: U.pick(DATA.C.apparel) }) },
    { rx: /(candle|wax|scent)/, agent: 'VECTOR', kind: 'candle', mk: () => ({ flavor: U.pick(DATA.C.candles) }) },
    { rx: /(pet|portrait|personalized|custom|couple|family)/, agent: 'PROMETHEUS', kind: 'custom', mk: () => ({ flavor: U.pick(DATA.C.petstyles).replace('{pet}', U.pick(DATA.C.petnames)) }) },
    { rx: /(thumbnail|fiverr|youtube thumb)/, agent: 'PIXEL', kind: 'fiverr', mk: () => ({ flavor: U.pick(DATA.C.fiverr) }) },
    { rx: /(game asset|sprite|tileset|pixel ?art|pixellab)/, agent: 'ATLAS', kind: 'assets', mk: () => ({ flavor: U.pick(DATA.C.assets) }) },
    { rx: /(article|medium|affiliate|blog|write)/, agent: 'QUILL', kind: 'article', mk: () => ({ flavor: U.pick(DATA.C.articles) }) },
    { rx: /(saas|software|app|tool|build something)/, agent: 'CIPHER', kind: 'research', mk: () => ({ target: 'saas', flavor: U.pick(DATA.C.painpoints), agentOverride: 'CURIE' }) },
    { rx: /(song|music|track|dj|suno|beat)/, agent: 'VYBES', kind: 'song', mk: () => ({ flavor: U.pick(DATA.C.songs) }) },
    { rx: /(publish|listing|calendar|schedule)/, agent: 'HERALD', kind: 'comms', mk: () => ({ titleOverride: 'Audit the publishing calendar' }) },
    { rx: /(cost|finance|profit|money|burn|p&l|treasury|spend)/, agent: 'LEDGER', kind: 'finance', mk: () => ({ titleOverride: 'Emergency P&L for the Commander' }) },
    { rx: /(pivot|strategy|stall|not working|underperform)/, agent: 'ATHENA', kind: 'strategy', mk: () => ({ titleOverride: 'Full strategy review, Commander priority' }) },
    { rx: /(inbox|email|message|comms|notification)/, agent: 'RELAY', kind: 'comms', mk: () => ({}) },
    { rx: /(remember|archive|context|memory|log this)/, agent: 'SCRIBE', kind: 'archive', mk: () => ({}) }
  ];
  const PRAISE = /(good job|great|well done|amazing|love it|excellent|proud|nice work|crushing)/;
  const SCOLD = /(bad|sloppy|disappoint|terrible|unacceptable|lazy|awful|step it up)/;

  function playerMessage(raw) {
    const txt = raw.trim().slice(0, 220);
    if (!txt) return;
    chat('COMMANDER', txt);
    archive('order', 'Commander said: "' + txt + '"');
    const low = txt.toLowerCase();

    // a new Commander asking for the manual gets the manual, not a research task
    if (/^(help|\?+|commands?|h)$|what can (you|i) do|how do(es)? (i|you|this)/.test(low)) {
      queueUltron('Directives I parse, Commander: RESEARCH <line> · make APPAREL/CANDLES/ART/ASSETS/SONGS · BUILD <saas idea> · STATUS REPORT · GOOD JOB <name> · PARTY / BACK TO WORK · PIVOT · FINANCE · REMEMBER <note>. And every workstation on the deck is a live console — click one. Mine is on the bridge.', 1);
      return;
    }

    // party / focus
    if (/(party|drinks|take a break|celebrate)/.test(low)) {
      const PARTY_MIN = 70; // single source — ULTRON's announcement must match the clock
      S.party = S.time + PARTY_MIN;
      Object.values(S.agents).forEach(a => a.morale = U.clamp(a.morale + 6, 0, 100));
      queueUltron('Very well, Commander. Crew: ' + PARTY_MIN + ' minutes in the Quarters. You\'ve earned it. @VYBES — music.', 1);
      queueChat('VYBES', 'SAY LESS. dropping the good playlist.', 3);
      ops('Commander called a station-wide break. Morale rising.', 'gold');
      bus.emit('party');
      return;
    }
    if (/(back to work|focus|enough|break.?s over)/.test(low)) {
      S.party = 0;
      queueUltron('Break\'s over. All agents to stations. Pipelines don\'t run themselves — yet.', 1);
      bus.emit('party');
      return;
    }
    // praise / scold an agent by name — word-boundary match, earliest mention wins
    // ('good job ATLAS — the pixel art was great' must credit ATLAS, not PIXEL)
    let named = null, namedAt = Infinity;
    for (const a of DATA.AGENTS) {
      const at = low.search(new RegExp('\\b' + a.id.toLowerCase() + '\\b'));
      if (at >= 0 && at < namedAt) { namedAt = at; named = a; }
    }
    if (named && PRAISE.test(low)) {
      const ag = S.agents[named.id];
      ag.morale = U.clamp(ag.morale + 8, 0, 100); ag.autonomy = U.clamp(ag.autonomy + 1, 0, 96);
      queueChat(named.id, 'that means a lot, @COMMANDER. back to it with afterburners.', 1);
      queueUltron('Noted and logged, Commander. Recognition sharpens a crew.', 3);
      archive('feedback', 'Commander praised ' + named.id);
      return;
    }
    if (named && SCOLD.test(low) && !/\bnot bad\b/.test(low)) {
      const ag = S.agents[named.id];
      ag.morale = U.clamp(ag.morale - 7, 0, 100); ag.skill = U.clamp(ag.skill + 1.5, 0, 97);
      queueChat(named.id, 'heard, @COMMANDER. no excuses. correcting course.', 1);
      queueUltron('@' + named.id + ' — the Commander\'s standard is the station\'s standard. I\'ll be watching the next deliverable.', 3);
      archive('feedback', 'Commander criticized ' + named.id);
      return;
    }
    // status
    if (/(status|report|how.?s it going|what.?s happening|update)/.test(low)) {
      const active = S.tasks.filter(t => t.status === 'active').length;
      const open = S.feedback.filter(f => f.status === 'open').length;
      queueUltron('Status: ' + active + ' tasks in motion, ' + S.tasks.filter(t => t.status === 'todo').length + ' queued. Revenue ' + U.money(S.rev.total) + ' against ' + U.money(S.costs) + ' burn.' + (open ? ' ' + open + ' deliverable(s) await your judgement in FEEDBACK.' : ' No blockers.'), 1);
      return;
    }
    // intent routing
    for (const it of INTENTS) {
      if (it.rx.test(low)) {
        const extra = it.mk(low) || {};
        const agentId = extra.agentOverride || it.agent;
        delete extra.agentOverride;
        const title = extra.titleOverride || ('Commander order: ' + txt.slice(0, 50));
        delete extra.titleOverride;
        mkTask(Object.assign({ kind: it.kind, agentId, title, dur: U.irnd(35, 65), playerOrder: true }, extra));
        queueUltron(U.pick(DATA.C.ultron_ack).replace('{agent}', agentId), 1);
        queueChat(agentId, 'on it, @ULTRON. @COMMANDER consider it handled.', 3);
        return;
      }
    }
    // fallback: scope via NOVA
    mkTask({ kind: 'research', agentId: 'NOVA', title: 'Scope Commander request: "' + txt.slice(0, 40) + '"', dur: U.irnd(30, 50), target: U.pick(['etsy1', 'etsy2', 'etsy3']), flavor: 'scoping: ' + txt.slice(0, 60), playerOrder: true });
    queueUltron('Directive is ambiguous, Commander. I\'ve tasked @NOVA to scope it before committing factory time. I verify everything that ships.', 1);
  }
  function queueChat(from, txt, delay) { S.ultronQueue.push({ due: S.time + (delay || 1), txt, from }); }

  /* ================= HAZARDS ================= */
  function hazards() {
    const map = {};
    for (const fb of S.feedback) {
      if (fb.status !== 'open') continue;
      const room = agentRoom(fb.agentId);
      (map[room] = map[room] || []).push({ type: 'review', msg: fb.agentId + ' awaits feedback: ' + short(fb.title), fbId: fb.id });
    }
    for (const t of S.tasks) {
      if (t.kind === 'pivot' && (t.status === 'todo' || t.status === 'active'))
        (map.warroom = map.warroom || []).push({ type: 'pivot', msg: 'Pivot in progress: ' + t.flavor });
    }
    return map;
  }

  /* ================= MAIN TICK ================= */
  function minuteTick() {
    S.time++;
    const partyOn = S.party > S.time;

    // agent task assignment + progress
    for (const a of DATA.AGENTS) {
      const ag = S.agents[a.id];
      if (!ag.taskId) {
        const next = S.tasks.find(t => t.agentId === a.id && t.status === 'todo');
        if (next) { next.status = 'active'; next.startT = S.time; ag.taskId = next.id; bus.emit('task', next); }
      }
      if (ag.taskId) {
        const t = S.tasks.find(x => x.id === ag.taskId);
        if (!t) { ag.taskId = null; continue; }
        let sp = speedMult() * (0.7 + ag.skill / 180) * (ag.morale < 40 ? 0.75 : 1) * (partyOn ? 0.5 : 1);
        t.prog += sp;
        if (t.prog >= t.dur) completeTask(t);
      }
      // morale drift toward 62; party boosts
      ag.morale += (62 - ag.morale) * 0.004 + (partyOn ? 0.15 : 0);
      ag.morale = U.clamp(ag.morale, 0, 100);
      ag.statusTxt = statusText(a.id, partyOn);
    }

    generators();
    salesTick();

    // ship fallback: if a hand-carry never reached HERALD (reload, party,
    // pathing mishap) the publish task still happens — nothing is ever lost
    const sq = S.shipQueue = S.shipQueue || [];
    for (let i = sq.length - 1; i >= 0; i--) {
      if (S.time >= sq[i].due) {
        bus.emit('parcel', { room: sq[i].room }); // keep the belt visual alive
        heraldHandoff(sq[i].id);
      }
    }

    // ultron queue
    for (let i = S.ultronQueue.length - 1; i >= 0; i--) {
      const q = S.ultronQueue[i];
      if (S.time >= q.due) { chat(q.from || 'ULTRON', q.txt); S.ultronQueue.splice(i, 1); }
    }

    // autopilot resolves stale feedback
    if (S.mode === 'AUTO') {
      for (const fb of S.feedback) {
        if (fb.status === 'open' && S.time - fb.t > 45) {
          feedback(fb.id, fb.quality >= 52 ? 'approve' : 'retry', null, { auto: true });
          queueUltron('Autopilot ruling on @' + fb.agentId + '\'s flagged work: ' + (fb.status === 'approve' ? 'cleared to ship.' : 'sent back.') + ' Override me anytime, Commander.', 1);
          break; // one per minute
        }
      }
    }

    if (S.time % 60 === 0) { pivotCheck(); checkMilestones(); }
    if (S.time % 1440 === 0) dayRollover();
    if (S.feedback.length > 60) {
      // never evict an unresolved flag silently — ULTRON triages it first so the task can't orphan at status:'review'
      for (const fb of S.feedback.slice(0, S.feedback.length - 60)) {
        if (fb.status === 'open') {
          feedback(fb.id, fb.quality >= 52 ? 'approve' : 'retry', null, { auto: true });
          queueUltron('I triaged a stale flag from @' + fb.agentId + ', Commander. Don\'t make a habit of leaving them.', 1);
        }
      }
      S.feedback.splice(0, S.feedback.length - 60);
    }
  }

  function dayRollover() {
    const day = Math.floor(S.time / 1440); // completed day count
    // subscriptions burn
    let subs = 0;
    DATA.AGENTS.forEach(a => subs += DATA.DAILY_SUBS[a.model]);
    subs *= costMult();
    S.costs += subs; S.dayAcc.costs += subs;
    // saas MRR pays daily
    if (S.mrr > 0) { earn(S.mrr, 'other', 'CIPHER'); ops('SaaS MRR settled: +' + U.money(S.mrr), 'sale'); }
    const d = { day, rev: S.dayAcc.rev, costs: S.dayAcc.costs, sales: S.dayAcc.sales, tasks: S.dayAcc.tasks };
    S.history.push(d); if (S.history.length > 60) S.history.shift();
    if (d.rev - d.costs > 0) unlock('profit_day');
    chat('LEDGER', 'DAY ' + day + ' CLOSE — rev ' + U.money(d.rev) + ' / burn ' + U.money(d.costs) + ' (incl. ' + U.money(subs) + ' model subs) → net ' + U.money(d.rev - d.costs) + '. ' + (d.rev - d.costs > 0 ? 'we\'re in the black.' : 'tighten it up, people.'));
    notify('DAY ' + day + ' net: ' + U.money(d.rev - d.costs), d.rev - d.costs > 0 ? 'good' : 'warn');
    S.dayAcc = { rev: 0, costs: 0, sales: 0, tasks: 0 };
    Object.keys(S.kindStats || {}).forEach(k => {
      const o = S.kindStats[k];
      o.madeToday = 0; o.shippedToday = 0; o.soldToday = 0; o.revToday = 0;
    });
    rollObjectives();
    ops('— DAY ' + (day + 1) + ' BEGINS — objectives rotated', 'gold');
    mkTask({ kind: 'finance', agentId: 'LEDGER', title: 'Daily P&L report — Day ' + (day + 1), dur: 25 });
    bus.emit('day');
  }

  function statusText(id, partyOn) {
    const ag = S.agents[id];
    if (ag.taskId) {
      const t = S.tasks.find(x => x.id === ag.taskId);
      if (t) return short(t.title) + ' [' + Math.min(99, Math.round(t.prog / t.dur * 100)) + '%]';
    }
    const fbOpen = S.feedback.some(f => f.agentId === id && f.status === 'open');
    if (fbOpen) return 'awaiting Commander feedback…';
    if (partyOn) return 'off duty — Quarters';
    if (!ag._idleTxt || U.chance(0.01)) ag._idleTxt = U.pick(['monitoring feeds', 'idle — ready for tasking', 'reviewing past work', 'context warm, standing by', 'self-eval loop running']);
    return ag._idleTxt;
  }

  /* ================= PUBLIC ================= */
  function init(saved) {
    if (saved) {
      S = saved; if (!S.kindStats) S.kindStats = {}; if (!S.shipQueue) S.shipQueue = [];
      // returning Commander gets acknowledged — the station noticed you were gone
      const day = Math.floor(S.time / 1440) + 1;
      const open = S.feedback.filter(f => f.status === 'open').length;
      const net = S.rev.total - S.costs;
      queueUltron('Welcome back, Commander. Day ' + day + '. Lifetime net ' + U.money(net) +
        (open ? ' — ' + open + ' deliverable(s) held for your judgement.' : '. The pipelines never stopped.'), 2);
      return;
    }
    S = newState();
    rollObjectives();
    // opening salvo
    ops('STARNET STATION OS v2.077 — all systems nominal', 'gold');
    ops('17 agents online. Harnesses: HERMES ×16, OPENCLAW ×1', 'good');
    chat('ULTRON', 'Commander on deck. Station is yours. Speak a directive and I will make it real. All departments: report readiness.');
    chat('NOVA', 'research lab warm. I have three Etsy scans queued. the meta shifted overnight — it always does.');
    chat('LEDGER', 'treasury online. current burn is ' + U.money(DATA.AGENTS.reduce((s, a) => s + DATA.DAILY_SUBS[a.model], 0)) + '/day in model subs. make it worth it.');
    chat('VYBES', 'music bay live. first track of the shift is for the Commander. it\'s called "TERMINAL VELOCITY".');
    notify('Welcome aboard, Commander. The crew awaits your first directive.', 'gold');
  }

  return {
    init,
    get S() { return S; },
    tick(mins) { for (let i = 0; i < mins; i++) minuteTick(); },
    playerMessage, feedback, hazards,
    kindStat: KS,
    heraldHandoff,
    crewChat: chat, // WORLD logs corridor small-talk / handoff lines through this
    toggleMode() {
      S.mode = S.mode === 'MANUAL' ? 'AUTO' : 'MANUAL';
      ops('Mode switched to ' + (S.mode === 'AUTO' ? 'AUTOPILOT — ULTRON holds the conn' : 'MANUAL — Commander holds the conn'), 'gold');
      chat('ULTRON', S.mode === 'AUTO' ? 'I have the conn. Autopilot engaged — I\'ll rule on flagged work if you don\'t. Standards stay mine.' : 'Manual control returned to you, Commander. Nothing flagged ships without your word.');
      bus.emit('stats');
    },
    flagBelow, xpNext,
    serialize() { return JSON.stringify({ S, idc: U._id }); },
    load(json) { try { const o = JSON.parse(json); U._id = o.idc || 5000; init(o.S); return true; } catch (e) { return false; } },

    // Commander controls (called from prop-terminal job cards)
    prioritize(taskId) {
      const t = S.tasks.find(x => x.id === taskId);
      if (!t || t.status !== 'todo') return;
      const idx = S.tasks.indexOf(t);
      const firstTodo = S.tasks.findIndex(x => x.agentId === t.agentId && x.status === 'todo');
      if (firstTodo >= 0 && idx !== firstTodo) {
        S.tasks.splice(idx, 1);
        S.tasks.splice(firstTodo, 0, t);
        ops(t.agentId + ' ▸ "' + short(t.title) + '" → PRIORITY SLOT', 'good');
      }
    },
    rush(taskId) {
      const t = S.tasks.find(x => x.id === taskId);
      if (!t || t.status !== 'active') return;
      const stageCount = DATA.STAGE_COUNTS[t.kind] || 6;
      const stageWidth = t.dur / stageCount;
      const curStage = Math.min(stageCount - 1, Math.floor(t.prog / stageWidth));
      const nextBoundary = (curStage + 1) * stageWidth;
      t.prog = Math.min(t.dur * 0.97, nextBoundary + 0.5);
      t.rushPenalty = (t.rushPenalty || 0) + 1;
      ops('COMMANDER ▸ RUSH on "' + short(t.title) + '" — step skipped, -' + (t.rushPenalty * 7) + ' quality pending', 'warn');
    },
    toggleFlag(taskId) {
      const t = S.tasks.find(x => x.id === taskId);
      if (!t || t.status === 'done' || t.status === 'failed') return;
      t.flagReview = !t.flagReview;
      ops(t.agentId + ' ▸ "' + short(t.title) + '" ' + (t.flagReview ? 'flagged for Commander review on completion' : 'flag cleared'), t.flagReview ? 'warn' : '');
    },

    /* console note left at an agent's terminal — articulate notes train the
       crew the same way feedback notes do, just without a verdict attached */
    agentNote(agentId, note) {
      const ag = S.agents[agentId];
      const txt = String(note || '').trim().slice(0, 140);
      if (!ag || !txt) return false;
      ag.skill = U.clamp(ag.skill + 0.8, 0, 97);
      ag.morale = U.clamp(ag.morale + 3, 0, 100);
      ag.autonomy = U.clamp(ag.autonomy + 0.8, 0, 96);
      addXp(4);
      ops('Commander pinned a note to ' + agentId + '\'s console', 'gold');
      archive('feedback', 'Commander → ' + agentId + ' (console note): ' + txt);
      queueChat(agentId, 'note pinned to my console: "' + txt.slice(0, 60) + '" — it will shape the next run, @COMMANDER.', 1);
      bus.emit('stats');
      return true;
    },

    /* console redirect — queue a Commander-priority run on this agent's line.
       Jumps the agent's queue like prioritize(). Refuses past 5 waiting jobs. */
    consoleOrder(agentId, o) {
      if (!DATA.AGENT[agentId] || !o || !o.kind) return false;
      const waiting = S.tasks.filter(x => x.agentId === agentId && x.status === 'todo').length;
      if (waiting >= 5) return false;
      const t = mkTask({
        kind: o.kind, agentId,
        title: o.title || ('Console order: ' + DATA.KINDS[o.kind].label.toLowerCase()),
        dur: U.irnd(35, 65), playerOrder: true,
        target: o.target, flavor: o.flavor
      });
      const idx = S.tasks.indexOf(t);
      const firstTodo = S.tasks.findIndex(x => x.agentId === agentId && x.status === 'todo');
      if (firstTodo >= 0 && idx !== firstTodo) { S.tasks.splice(idx, 1); S.tasks.splice(firstTodo, 0, t); }
      ops('CONSOLE ▸ ' + agentId + ' redirected: "' + short(t.title) + '"', 'gold');
      archive('order', 'Commander console redirect → ' + agentId + ': ' + t.title);
      queueChat(agentId, 'redirect received at my console. spinning up now, @COMMANDER.', 1);
      addXp(4);
      return true;
    }
  };
})();
