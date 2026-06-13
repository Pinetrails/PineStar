/* SKYNET - map.js : station geometry, walkability, pathfinding
   Layout v7.2 "WIDE WINGS": the v7.1 acorn-octagon skeleton on a 74-col grid,
   with both factories pushed further outboard on long hub-link corridors and
   every room corner cut for the rounded-hull render pass. */
'use strict';

const MAP = (() => {
  const TILE = 12, COLS = 78, ROWS = 55;

  /* floor rects per zone (inclusive tile coords) */
  const zones = {
    bridge:     { x1: 28, y1: 3, x2: 45, y2: 10 },
    research:   { x1: 9, y1: 12, x2: 29, y2: 19 },
    comms:      { x1: 44, y1: 12, x2: 64, y2: 19 },
    factory1:   { x1: 0, y1: 23, x2: 24, y2: 33 },
    factory2:   { x1: 49, y1: 23, x2: 76, y2: 33 },
    treasury:   { x1: 5, y1: 36, x2: 16, y2: 43 },
    warroom:    { x1: 19, y1: 36, x2: 34, y2: 43 },
    publishing: { x1: 39, y1: 36, x2: 52, y2: 43 },
    archives:   { x1: 55, y1: 36, x2: 68, y2: 43 },
    quarters:   { x1: 26, y1: 46, x2: 47, y2: 53 },
    hub:        { x1: 31, y1: 25, x2: 42, y2: 30 },
    spine_n:    { x1: 35, y1: 11, x2: 38, y2: 22 },
    spine_s:    { x1: 35, y1: 33, x2: 38, y2: 45 },
    cor_re:     { x1: 30, y1: 15, x2: 34, y2: 16 },
    cor_co:     { x1: 39, y1: 15, x2: 43, y2: 16 },
    stub_rf:    { x1: 20, y1: 20, x2: 21, y2: 22 },
    stub_cf:    { x1: 52, y1: 20, x2: 53, y2: 22 },
    cor_f1h:    { x1: 25, y1: 27, x2: 30, y2: 28 },
    cor_f2h:    { x1: 43, y1: 27, x2: 48, y2: 28 },
    cor_tw:     { x1: 17, y1: 39, x2: 18, y2: 40 },
    cor_pa:     { x1: 53, y1: 39, x2: 54, y2: 40 }
  };
  const ROOM_IDS = ['bridge', 'research', 'comms', 'factory1', 'factory2', 'treasury', 'warroom', 'publishing', 'archives', 'quarters'];
  const isCorridor = z => !ROOM_IDS.includes(z);

  /* octagon steps merged into a zone */
  const extras = [
    { z: 'hub', x1: 33, y1: 23, x2: 40, y2: 24 },  // hub octagon top
    { z: 'hub', x1: 33, y1: 31, x2: 40, y2: 32 }  // hub octagon bottom
  ];

  /* rounded corners: these floor tiles are cut away (blocked + drawn as curved hull) */
  const chamfers = [
    [28, 3, 'tl'], [45, 3, 'tr'], [28, 10, 'bl'], [45, 10, 'br'],
    [9, 12, 'tl'], [29, 12, 'tr'], [9, 19, 'bl'], [29, 19, 'br'],
    [44, 12, 'tl'], [64, 12, 'tr'], [44, 19, 'bl'], [64, 19, 'br'],
    [0, 23, 'tl'], [24, 23, 'tr'], [0, 33, 'bl'], [24, 33, 'br'],
    [49, 23, 'tl'], [76, 23, 'tr'], [49, 33, 'bl'], [76, 33, 'br'],
    [33, 23, 'tl'], [40, 23, 'tr'], [31, 25, 'tl'], [42, 25, 'tr'],
    [31, 30, 'bl'], [42, 30, 'br'], [33, 32, 'bl'], [40, 32, 'br'],
    [5, 36, 'tl'], [16, 36, 'tr'], [5, 43, 'bl'], [16, 43, 'br'],
    [19, 36, 'tl'], [34, 36, 'tr'], [19, 43, 'bl'], [34, 43, 'br'],
    [39, 36, 'tl'], [52, 36, 'tr'], [39, 43, 'bl'], [52, 43, 'br'],
    [55, 36, 'tl'], [68, 36, 'tr'], [55, 43, 'bl'], [68, 43, 'br'],
    [26, 46, 'tl'], [47, 46, 'tr'], [26, 53, 'bl'], [47, 53, 'br']
  ];

  /* door edges: pairs of adjacent tiles allowed to cross zones */
  const doorDefs = [
    [36, 10, 36, 11], [37, 10, 37, 11],   // bridge - north spine
    [29, 15, 30, 15], [29, 16, 30, 16],   // research - east corridor
    [34, 15, 35, 15], [34, 16, 35, 16],   // corridor - north spine
    [38, 15, 39, 15], [38, 16, 39, 16],   // north spine - corridor
    [43, 15, 44, 15], [43, 16, 44, 16],   // corridor - comms
    [20, 19, 20, 20], [21, 19, 21, 20],   // research - factory1 stub
    [20, 22, 20, 23], [21, 22, 21, 23],   // stub - factory1
    [52, 19, 52, 20], [53, 19, 53, 20],   // comms - factory2 stub
    [52, 22, 52, 23], [53, 22, 53, 23],   // stub - factory2
    [36, 22, 36, 23], [37, 22, 37, 23],   // north spine - hub
    [36, 32, 36, 33], [37, 32, 37, 33],   // hub - south spine
    [24, 27, 25, 27], [24, 28, 25, 28],   // factory1 - hub link
    [30, 27, 31, 27], [30, 28, 31, 28],   // hub link - hub
    [42, 27, 43, 27], [42, 28, 43, 28],   // hub - hub link
    [48, 27, 49, 27], [48, 28, 49, 28],   // hub link - factory2
    [16, 39, 17, 39], [16, 40, 17, 40],   // treasury - link
    [18, 39, 19, 39], [18, 40, 19, 40],   // link - warroom
    [34, 39, 35, 39], [34, 40, 35, 40],   // warroom - south spine
    [38, 39, 39, 39], [38, 40, 39, 40],   // south spine - publishing
    [52, 39, 53, 39], [52, 40, 53, 40],   // publishing - link
    [54, 39, 55, 39], [54, 40, 55, 40],   // link - archives
    [36, 45, 36, 46], [37, 45, 37, 46]    // south spine - quarters
  ];

  /* furniture: type, tile rect, options. blocked unless sit:true or deco:true
     placement rules: big units anchor to walls, workstations form straight rows,
     door lanes stay clear, every prop earns its spot - no loose scatter */
  const furniture = [
    /* -- bridge: command deck mirrored on the x=36.5 centerline. viewscreen
       front-center, captain's chair on the line, holotable behind it,
       matched consoles/desks up front, towers tucked in the rear corners
       so the side viewports stay clear -- */
    { t: 'bigscreen', x: 33, y: 3, w: 8, h: 1, pw: 'bridge_main', pwl: 'ULTRON CORE' },
    { t: 'consoleL', x: 29, y: 3, w: 3, h: 1 },
    { t: 'consoleL', x: 42, y: 3, w: 3, h: 1 },
    { t: 'desk2', x: 29, y: 4, w: 2, h: 1 },
    { t: 'desk2', x: 43, y: 4, w: 2, h: 1 },
    { t: 'chair', x: 36, y: 5, sit: true, big: true },
    { t: 'holotable', x: 35, y: 6, w: 4, h: 2, pw: 'bridge_delegation', pwl: 'DELEGATION HOLO' },
    { t: 'bridge_orderqueue', x: 32, y: 8, w: 2, h: 1, pw: 'bridge_directives', pwl: 'ORDER QUEUE' },
    { t: 'bridge_orderqueue', x: 40, y: 8, w: 2, h: 1, pw: 'bridge_directives', pwl: 'ORDER QUEUE' },
    { t: 'core', x: 28, y: 8, w: 1, h: 2 },
    { t: 'rackV', x: 45, y: 8, w: 1, h: 2 },
    { t: 'plant', x: 29, y: 9 },
    { t: 'plant', x: 44, y: 9 },
    /* -- hub plaza -- */
    { t: 'holotable', x: 35, y: 27, w: 4, h: 2, pw: 'hub_overview', pwl: 'STATION HOLO' },
    { t: 'plant', x: 33, y: 24 },
    { t: 'plant', x: 40, y: 24 },
    /* -- research: instrument wall along the top, desk row mid-room,
       bench line + equipment hugging the south wall -- */
    { t: 'core', x: 10, y: 12, w: 1, h: 2 },
    { t: 'screens', x: 11, y: 12, w: 4, h: 1 },
    { t: 'tank', x: 16, y: 12, w: 2, h: 1 },
    { t: 'whiteboard', x: 19, y: 12, w: 4, h: 1, pw: 'research_briefs', pwl: 'BRIEF BOARD' },
    { t: 'rack', x: 24, y: 12, w: 2, h: 1 },
    { t: 'chartwall', x: 26, y: 12, w: 3, h: 1, pw: 'research_findings', pwl: 'FINDINGS WALL' },
    { t: 'research_corelens', x: 28, y: 13, w: 1, h: 2 },
    { t: 'desk', x: 12, y: 15, w: 2, h: 1, pw: 'research_nova', pwl: 'LAB-01 ▪ NOVA' },
    { t: 'chair', x: 13, y: 16, sit: true },
    { t: 'desk', x: 17, y: 15, w: 2, h: 1, pw: 'research_curie', pwl: 'LAB-02 ▪ CURIE' },
    { t: 'chair', x: 18, y: 16, sit: true },
    { t: 'bench', x: 11, y: 18, w: 6, h: 1 },
    { t: 'coffee', x: 19, y: 18 },
    { t: 'research_trendpillar', x: 23, y: 17, w: 1, h: 2 },
    { t: 'plant', x: 27, y: 18 },
    /* -- comms: signal wall north, operator row (rack/desk/inbox) mid-west,
       antenna cluster (dish + beacon) grouped under the rack east -- */
    { t: 'commswall', x: 46, y: 12, w: 14, h: 1, pw: 'comms_channels', pwl: 'CHANNEL WALL' },
    { t: 'rack', x: 61, y: 12, w: 2, h: 1 },
    { t: 'comms_dish', x: 60, y: 14, w: 2, h: 2 },
    { t: 'comms_beacon', x: 63, y: 14, w: 1, h: 2 },
    { t: 'rackV', x: 48, y: 15, w: 1, h: 2 },
    { t: 'desk', x: 49, y: 15, w: 2, h: 1, pw: 'comms_relay', pwl: 'COM-01 ▪ RELAY' },
    { t: 'chair', x: 50, y: 16, sit: true },
    { t: 'comms_inbox', x: 53, y: 15, w: 2, h: 1, pw: 'comms_inbox', pwl: 'INBOX' },
    { t: 'plant', x: 45, y: 18 },
    { t: 'bench', x: 54, y: 18, w: 4, h: 1 },
    { t: 'crate', x: 61, y: 18, w: 2, h: 1 },
    { t: 'plant', x: 63, y: 18 },
    /* -- factory1: craft stations in a row along the top, dye/kiln stack on
       the west wall, belt mid, packbot + storage on the south side -- */
    { t: 'poster', x: 3, y: 23, deco: true },
    { t: 'fabricator', x: 4, y: 23, w: 3, h: 2, pw: 'etsy1', pwl: 'ETSY 1 ▪ APPAREL' },
    { t: 'chair', x: 5, y: 25, sit: true },
    { t: 'etsy_threadrack', x: 7, y: 23, w: 2, h: 1 },
    { t: 'bench', x: 7, y: 24, w: 2, h: 1 },
    { t: 'vat', x: 10, y: 23, w: 3, h: 2, pw: 'etsy2', pwl: 'ETSY 2 ▪ CANDLES' },
    { t: 'chair', x: 11, y: 25, sit: true },
    { t: 'easel', x: 17, y: 23, w: 3, h: 2, pw: 'etsy3', pwl: 'ETSY 3 ▪ CUSTOM ART' },
    { t: 'chair', x: 18, y: 25, sit: true },
    { t: 'etsy_dyevat', x: 2, y: 26, w: 2, h: 2 },
    { t: 'etsy_kiln', x: 2, y: 29, w: 2, h: 2 },
    { t: 'beltH', x: 4, y: 28, w: 16, h: 1 },
    { t: 'etsy_packbot', x: 14, y: 30, w: 2, h: 2 },
    { t: 'crate', x: 3, y: 31, w: 2, h: 2 },
    { t: 'boxes', x: 8, y: 31, w: 2, h: 1 },
    { t: 'plant', x: 23, y: 33, w: 1, h: 1, deco: true },
    /* -- factory2: one straight computer row along the top (desk, pixel rig,
       desk, desk, rack, server cart), belt mid, core + parts bin on the west
       wall, dj gear lined up y=30, storage in the south-east corner -- */
    { t: 'poster', x: 58, y: 23, deco: true },
    { t: 'gigs_thumbwall', x: 66, y: 23, w: 2, h: 1 },
    { t: 'desk2', x: 51, y: 24, w: 2, h: 1, pw: 'fiverr', pwl: 'FIVERR RIG' },
    { t: 'chair', x: 51, y: 25, sit: true },
    { t: 'pixelrig', x: 56, y: 24, w: 2, h: 1, pw: 'assets', pwl: 'GAME ASSETS' },
    { t: 'chair', x: 56, y: 25, sit: true },
    { t: 'desk2', x: 61, y: 24, w: 2, h: 1, pw: 'press', pwl: 'AFFILIATE PRESS' },
    { t: 'chair', x: 61, y: 25, sit: true },
    { t: 'desk2', x: 66, y: 24, w: 2, h: 1, pw: 'saas', pwl: 'SAAS FOUNDRY' },
    { t: 'chair', x: 66, y: 25, sit: true },
    { t: 'rack', x: 70, y: 24, w: 2, h: 1 },
    { t: 'gigs_servercart', x: 73, y: 24, w: 2, h: 1 },
    { t: 'beltH', x: 51, y: 28, w: 14, h: 1 },
    { t: 'core', x: 50, y: 29, w: 1, h: 2 },
    { t: 'gigs_partsbin', x: 50, y: 31, w: 2, h: 1 },
    { t: 'gigs_amp', x: 64, y: 30, w: 1, h: 1 },
    { t: 'speaker', x: 65, y: 30 },
    { t: 'djbooth', x: 66, y: 30, w: 4, h: 2, pw: 'music', pwl: 'MUSIC BAY' },
    { t: 'speaker', x: 70, y: 30 },
    { t: 'chair', x: 68, y: 32, sit: true },
    { t: 'crate', x: 70, y: 32, w: 2, h: 1 },
    { t: 'boxes', x: 73, y: 32, w: 2, h: 1 },
    { t: 'plant', x: 51, y: 33, w: 1, h: 1, deco: true },
    /* -- treasury: vault wall north (vault/ticker/safe, pnl holo under the
       ticker), ledger desk + coin sorter mid, furnace and a neat gold
       reserve row along the south wall -- */
    { t: 'vault', x: 6, y: 36, w: 3, h: 2, pw: 'treasury_pnl', pwl: 'THE VAULT ▪ P&L' },
    { t: 'ticker', x: 10, y: 36, w: 4, h: 1, pw: 'treasury_burn', pwl: 'BURN TICKER' },
    { t: 'treasury_pnl_holo', x: 12, y: 37, w: 1, h: 1, pw: 'treasury_pnl', pwl: 'P&L HOLO' },
    { t: 'safe', x: 14, y: 36, w: 1, h: 2 },
    { t: 'desk', x: 8, y: 39, w: 2, h: 1, pw: 'treasury_ledger', pwl: 'TRS-01 ▪ LEDGER' },
    { t: 'chair', x: 9, y: 40, sit: true },
    { t: 'treasury_coinsorter', x: 11, y: 39, w: 2, h: 1 },
    { t: 'treasury_token_furnace', x: 5, y: 41, w: 1, h: 2 },
    { t: 'goldcrate', x: 7, y: 42, w: 2, h: 1 },
    { t: 'goldcrate', x: 10, y: 42, w: 2, h: 1 },
    { t: 'goldcrate', x: 13, y: 42, w: 2, h: 1 },
    /* -- warroom: war table dead center (room spans x19-34/y36-43) with
       seats on both long sides, full display wall north, intel gear on the
       east wall, racks flanking the west door -- */
    { t: 'chartwall', x: 21, y: 36, w: 8, h: 1, pw: 'war_signal', pwl: 'SIGNAL WALL ▪ RAVEN' },
    { t: 'screens', x: 30, y: 36, w: 2, h: 1 },
    { t: 'war_pivotpanel', x: 32, y: 36, w: 2, h: 1, pw: 'war_pivots', pwl: 'PIVOT BOARD' },
    { t: 'rackV', x: 20, y: 37, w: 1, h: 2 },
    { t: 'consoleL', x: 21, y: 37, w: 3, h: 1 },
    { t: 'war_intelcab', x: 33, y: 37, w: 1, h: 2 },
    { t: 'chair', x: 26, y: 38, sit: true },
    { t: 'chair', x: 28, y: 38, sit: true },
    { t: 'wartable', x: 25, y: 39, w: 5, h: 2, pw: 'war_lines', pwl: 'WAR TABLE' },
    { t: 'chair', x: 26, y: 41, sit: true },
    { t: 'chair', x: 28, y: 41, sit: true },
    { t: 'rackV', x: 20, y: 41, w: 1, h: 2 },
    { t: 'war_threatcore', x: 33, y: 41, w: 1, h: 2 },
    /* -- publishing: cal wall + display row north, mail gear mid,
       press/chute/parcels grouped south-east -- */
    { t: 'calwall', x: 41, y: 36, w: 9, h: 1, pw: 'pub_calendar', pwl: 'PUBLISH CALENDAR' },
    { t: 'screens', x: 40, y: 37, w: 3, h: 1 },
    { t: 'ticker', x: 45, y: 37, w: 3, h: 1 },
    { t: 'rackV', x: 51, y: 37, w: 1, h: 2 },
    { t: 'pub_mailpod', x: 45, y: 38, w: 2, h: 1 },
    { t: 'tube', x: 49, y: 38, w: 2, h: 1 },
    { t: 'desk', x: 43, y: 39, w: 2, h: 1, pw: 'pub_herald', pwl: 'PUB-01 ▪ HERALD' },
    { t: 'chair', x: 43, y: 40, sit: true },
    { t: 'pub_publishpress', x: 46, y: 41, w: 2, h: 2, pw: 'pub_totals', pwl: 'PUBLISH PRESS' },
    { t: 'parcels', x: 50, y: 41, w: 1, h: 2 },
    { t: 'pub_outboundchute', x: 49, y: 42, w: 1, h: 2 },
    { t: 'parcels', x: 40, y: 42 },
    { t: 'plant', x: 40, y: 43, w: 1, h: 1, deco: true },
    /* -- archives: index wall north, two aligned rows of stacks,
       core + scribe desk + safe on the east wall -- */
    { t: 'rack', x: 56, y: 36, w: 2, h: 1 },
    { t: 'arc_indexwall', x: 58, y: 36, w: 4, h: 1, pw: 'arc_index', pwl: 'MEMORY INDEX' },
    { t: 'arc_microfiche', x: 64, y: 36, w: 2, h: 1 },
    { t: 'rackV', x: 57, y: 37, w: 1, h: 2 },
    { t: 'rackV', x: 59, y: 37, w: 1, h: 2 },
    { t: 'rackV', x: 61, y: 37, w: 1, h: 2 },
    { t: 'rackV', x: 63, y: 37, w: 1, h: 2 },
    { t: 'core', x: 67, y: 37, w: 1, h: 2 },
    { t: 'desk', x: 65, y: 40, w: 2, h: 1, pw: 'arc_scribe', pwl: 'ARC-01 ▪ SCRIBE' },
    { t: 'chair', x: 65, y: 41, sit: true },
    { t: 'rackV', x: 57, y: 41, w: 1, h: 2 },
    { t: 'rackV', x: 59, y: 41, w: 1, h: 2 },
    { t: 'rackV', x: 61, y: 41, w: 1, h: 2 },
    { t: 'rackV', x: 63, y: 41, w: 1, h: 2 },
    { t: 'safe', x: 67, y: 41, w: 1, h: 2 },
    { t: 'arc_floorlight', x: 58, y: 42, w: 1, h: 1, deco: true },
    { t: 'arc_floorlight', x: 62, y: 42, w: 1, h: 1, deco: true },
    { t: 'arc_ladder', x: 60, y: 43, w: 1, h: 1, deco: true },
    /* -- quarters: bar corner west, lounge (tv/couch/arcade) east,
       bunks south-west, pool + lockers south-east -- */
    { t: 'jukebox', x: 27, y: 46, w: 1, h: 2, pw: 'juke', pwl: 'JUKEBOX' },
    { t: 'shelf', x: 28, y: 46, w: 7, h: 1 },
    { t: 'bar', x: 28, y: 48, w: 7, h: 1, pw: 'lounge', pwl: 'THE BAR' },
    { t: 'stool', x: 29, y: 49, sit: true },
    { t: 'stool', x: 31, y: 49, sit: true },
    { t: 'stool', x: 33, y: 49, sit: true },
    { t: 'screens', x: 38, y: 46, w: 2, h: 1 },
    { t: 'tv', x: 40, y: 46, w: 3, h: 1, pw: 'morale', pwl: 'MORALE BOARD' },
    { t: 'couch', x: 39, y: 48, w: 5, h: 1, sit: true },
    { t: 'arcade', x: 45, y: 46, w: 1, h: 2, pw: 'arcade', pwl: 'ARCADE' },
    { t: 'arcade2', x: 46, y: 46, w: 1, h: 2, pw: 'arcade', pwl: 'ARCADE' },
    { t: 'bunk', x: 27, y: 51, w: 2, h: 2 },
    { t: 'bunk', x: 30, y: 51, w: 2, h: 2 },
    { t: 'quarters_pooltable', x: 38, y: 50, w: 4, h: 2 },
    { t: 'quarters_lockerbank', x: 38, y: 53, w: 3, h: 1 },
    { t: 'bunk', x: 44, y: 52, w: 2, h: 2 },
    { t: 'quarters_minifridge', x: 46, y: 50, w: 1, h: 1 },
    { t: 'quarters_vending', x: 47, y: 51, w: 1, h: 2 },
    { t: 'plant', x: 35, y: 52 },
    { t: 'plant', x: 47, y: 50, w: 1, h: 1, deco: true },
    { t: 'cans', x: 35, y: 49, deco: true },
    { t: 'cans', x: 44, y: 50, deco: true },
  ];

  /* agent workstations: chair tile (must match a sit furniture) */
  const stations = {
    ULTRON: { x: 36, y: 5 }, NOVA: { x: 13, y: 16 }, CURIE: { x: 18, y: 16 },
    RELAY: { x: 50, y: 16 },
    FORGE: { x: 5, y: 25 }, VECTOR: { x: 11, y: 25 }, PROMETHEUS: { x: 18, y: 25 },
    PIXEL: { x: 51, y: 25 }, ATLAS: { x: 56, y: 25 }, QUILL: { x: 61, y: 25 }, CIPHER: { x: 66, y: 25 },
    VYBES: { x: 68, y: 32 },
    HERALD: { x: 43, y: 40 }, LEDGER: { x: 9, y: 40 },
    ATHENA: { x: 26, y: 41 }, RAVEN: { x: 28, y: 41 },
    SCRIBE: { x: 65, y: 41 }
  };

  /* social spots in quarters */
  const social = [
    { x: 29, y: 49, kind: 'bar' }, { x: 31, y: 49, kind: 'bar' }, { x: 33, y: 49, kind: 'bar' },
    { x: 40, y: 48, kind: 'tv' }, { x: 41, y: 48, kind: 'tv' }, { x: 42, y: 48, kind: 'tv' },
    { x: 45, y: 48, kind: 'arcade' }, { x: 46, y: 48, kind: 'arcade' },
    { x: 33, y: 52, kind: 'window' }, { x: 41, y: 52, kind: 'window' }, { x: 28, y: 47, kind: 'juke' }
  ];

  /* windows: edge segments [tileX, tileY, side(n/s/e/w), len] showing space */
  const windows = [
    [28, 5, 'w', 3], [45, 5, 'e', 3], [9, 14, 'w', 3], [64, 14, 'e', 3],
    [0, 26, 'w', 3], [76, 26, 'e', 3], [5, 38, 'w', 3], [68, 38, 'e', 3],
    [30, 53, 's', 3], [40, 53, 's', 3]
  ];

  /* ---- build grids ---- */
  const zoneGrid = new Array(COLS * ROWS).fill(null);
  const blocked = new Uint8Array(COLS * ROWS);
  const sitTiles = {}; // "x,y" -> true
  const idx = (x, y) => y * COLS + x;

  for (const [zid, r] of Object.entries(zones))
    for (let y = r.y1; y <= r.y2; y++)
      for (let x = r.x1; x <= r.x2; x++)
        zoneGrid[idx(x, y)] = zid;
  for (const e of extras)
    for (let y = e.y1; y <= e.y2; y++)
      for (let x = e.x1; x <= e.x2; x++)
        zoneGrid[idx(x, y)] = e.z;
  for (const [cx, cy] of chamfers) blocked[idx(cx, cy)] = 1;

  /* all floor rects (main + steps), zone-tagged - for rendering & hull */
  const allRects = Object.entries(zones).map(([z, r]) => ({ z, x1: r.x1, y1: r.y1, x2: r.x2, y2: r.y2 }))
    .concat(extras.map(e => ({ z: e.z, x1: e.x1, y1: e.y1, x2: e.x2, y2: e.y2 })));

  for (const f of furniture) {
    f.w = f.w || 1; f.h = f.h || 1;
    if (f.deco) continue;
    if (f.sit) { for (let dy = 0; dy < f.h; dy++) for (let dx = 0; dx < f.w; dx++) sitTiles[(f.x + dx) + ',' + (f.y + dy)] = true; continue; }
    for (let dy = 0; dy < f.h; dy++) for (let dx = 0; dx < f.w; dx++) blocked[idx(f.x + dx, f.y + dy)] = 1;
  }

  /* interactive props (pw-tagged) — tile -> furniture lookup for hover/click */
  const pwGrid = new Array(COLS * ROWS).fill(null);
  for (const f of furniture) {
    if (!f.pw) continue;
    for (let dy = 0; dy < f.h; dy++) for (let dx = 0; dx < f.w; dx++) pwGrid[idx(f.x + dx, f.y + dy)] = f;
  }
  /* prop under a tile — checks one tile south too, since sprites draw upward
     past their footprint and the cursor often sits on that overhang */
  function propAt(tx, ty) {
    if (tx < 0 || ty < 0 || tx >= COLS || ty >= ROWS) return null;
    return pwGrid[idx(tx, ty)] || (ty + 1 < ROWS ? pwGrid[idx(tx, ty + 1)] : null);
  }

  const doorSet = new Set();
  for (const [x1, y1, x2, y2] of doorDefs) { doorSet.add(x1 + ',' + y1 + '>' + x2 + ',' + y2); doorSet.add(x2 + ',' + y2 + '>' + x1 + ',' + y1); }

  function walkable(x, y) {
    if (x < 0 || y < 0 || x >= COLS || y >= ROWS) return false;
    return zoneGrid[idx(x, y)] !== null && !blocked[idx(x, y)];
  }
  function canStep(x1, y1, x2, y2) {
    if (!walkable(x2, y2)) return false;
    const za = zoneGrid[idx(x1, y1)], zb = zoneGrid[idx(x2, y2)];
    if (za === zb) return true;
    return doorSet.has(x1 + ',' + y1 + '>' + x2 + ',' + y2);
  }

  /* BFS path. returns array of {x,y} tiles or null */
  function path(sx, sy, tx, ty) {
    if (sx === tx && sy === ty) return [];
    if (!walkable(tx, ty)) return null;
    const prev = new Int32Array(COLS * ROWS).fill(-1);
    const q = [idx(sx, sy)]; prev[idx(sx, sy)] = idx(sx, sy);
    const target = idx(tx, ty);
    while (q.length) {
      const cur = q.shift();
      if (cur === target) break;
      const cx = cur % COLS, cy = (cur / COLS) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + dx, ny = cy + dy, ni = idx(nx, ny);
        if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS || prev[ni] !== -1) continue;
        if (!canStep(cx, cy, nx, ny)) continue;
        prev[ni] = cur; q.push(ni);
      }
    }
    if (prev[target] === -1) return null;
    const out = []; let cur = target;
    while (cur !== idx(sx, sy)) { out.push({ x: cur % COLS, y: (cur / COLS) | 0 }); cur = prev[cur]; }
    return out.reverse();
  }

  function roomAt(tx, ty) {
    if (tx < 0 || ty < 0 || tx >= COLS || ty >= ROWS) return null;
    const z = zoneGrid[idx(tx, ty)];
    return z && !isCorridor(z) ? z : (z ? 'corridor' : null);
  }

  function randomSpotIn(zid, tries) {
    const r = zones[zid];
    for (let i = 0; i < (tries || 40); i++) {
      const x = U.irnd(r.x1, r.x2), y = U.irnd(r.y1, r.y2);
      if (walkable(x, y) && !sitTiles[x + ',' + y]) return { x, y };
    }
    return null;
  }

  /* H carries +14px so the extruded south hull face below the bottom rooms isn't clipped */
  return { TILE, COLS, ROWS, W: COLS * TILE, H: ROWS * TILE + 14, zones, allRects, chamfers, ROOM_IDS, isCorridor, furniture, stations, social, windows, doorDefs, zoneGrid, blocked, sitTiles, idx, walkable, canStep, path, roomAt, randomSpotIn, propAt };
})();
