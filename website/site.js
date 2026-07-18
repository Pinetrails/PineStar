/* StarNet site — boot sequence, platform detect, live release links */
(function(){
  'use strict';

  var FALLBACK_VERSION = '0.5.2';

  // Community links — paste real URLs here and the DISCORD / X links appear
  // everywhere automatically. Empty string keeps them hidden (no dead links).
  var SOCIAL = {
    discord: '',   // e.g. 'https://discord.gg/xxxxxxx'
    x: ''          // e.g. 'https://x.com/yourhandle'
  };
  document.querySelectorAll('.social-link').forEach(function(a){
    var url = SOCIAL[a.getAttribute('data-social')];
    if(url){ a.href = url; a.hidden = false; a.target = '_blank'; a.rel = 'noopener'; }
  });
  var RELEASES_REPO = 'nonfungiblefunyuns-ship-it/starnet-releases';
  var RELEASES_PAGE = 'https://github.com/' + RELEASES_REPO + '/releases/latest';

  /* ---------- boot sequence (once per session) ---------- */
  var bootLines = [
    '> STARNET TERMLINK',
    '> ESTABLISHING UPLINK ........... OK',
    '> STATION MANIFEST LOADED ....... OK',
    '> RENDERING TERMINAL'
  ];
  var boot = document.getElementById('boot');
  var flash = document.getElementById('boot-flash');
  var bootTimers = [];

  function endBoot(withFlash){
    bootTimers.forEach(clearTimeout);
    boot.classList.add('hidden');
    try{ sessionStorage.setItem('sn-booted','1'); }catch(e){}
    if(withFlash && flash){
      flash.hidden = false;
      setTimeout(function(){ flash.hidden = true; }, 560);
    }
  }

  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var booted = false;
  try{ booted = sessionStorage.getItem('sn-booted') === '1'; }catch(e){}

  if(booted || reduce){
    boot.classList.add('hidden');
  }else{
    var linesEl = document.getElementById('boot-lines');
    var step = 260;
    bootLines.forEach(function(line, i){
      bootTimers.push(setTimeout(function(){
        var d = document.createElement('div');
        d.textContent = line;
        linesEl.appendChild(d);
      }, step * (i + 1)));
    });
    bootTimers.push(setTimeout(function(){ endBoot(true); }, step * bootLines.length + 600));
    boot.addEventListener('click', function(){ endBoot(false); });
    window.addEventListener('keydown', function onKey(){ endBoot(false); window.removeEventListener('keydown', onKey); });
  }

  /* ---------- platform detection ---------- */
  function detectOS(){
    var ua = navigator.userAgent || '';
    var plat = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
    if(/Windows/i.test(ua) || /Win/i.test(plat)) return 'windows';
    if(/Macintosh|Mac OS X/i.test(ua) || /Mac/i.test(plat)){
      // Apple Silicon Macs report Intel in UA; default to arm (the common case for new downloads)
      return 'mac-arm';
    }
    if(/Android/i.test(ua)) return null;
    if(/Linux/i.test(ua) || /Linux/i.test(plat)) return 'linux-appimage';
    return null;
  }

  var os = detectOS();
  var osLabels = {
    'windows':'WINDOWS', 'mac-arm':'MACOS', 'mac-intel':'MACOS',
    'linux-deb':'LINUX', 'linux-appimage':'LINUX'
  };
  if(os){
    var card = document.querySelector('.dl-card[data-os="' + os + '"]');
    if(card) card.classList.add('detected');
    var cta = document.getElementById('cta-download');
    if(cta) cta.textContent = '[ DOWNLOAD FOR ' + osLabels[os] + ' ]';
  }

  /* ---------- live release links ---------- */
  function setVersion(v){
    var tag = v.replace(/^v/,'');
    ['ver-badge','ver-foot'].forEach(function(id){
      var el = document.getElementById(id);
      if(el) el.textContent = 'v' + tag;
    });
    document.querySelectorAll('.ver').forEach(function(el){ el.textContent = 'v' + tag; });
  }
  setVersion(FALLBACK_VERSION);

  // Try to resolve exact asset URLs from the latest release. If the API call
  // fails (offline, rate limit, repo not public yet) the buttons keep their
  // fallback href: the releases page itself. Never a dead link.
  fetch('https://api.github.com/repos/' + RELEASES_REPO + '/releases/latest')
    .then(function(r){ if(!r.ok) throw new Error(r.status); return r.json(); })
    .then(function(rel){
      if(rel.tag_name) setVersion(rel.tag_name);
      var assets = rel.assets || [];
      document.querySelectorAll('.dl-btn[data-asset]').forEach(function(btn){
        var suffix = btn.getAttribute('data-asset');
        var match = assets.find(function(a){ return a.name.indexOf(suffix) !== -1; });
        if(match) btn.href = match.browser_download_url;
      });
    })
    .catch(function(){ /* fallback links already in place */ });

  /* ---------- copy buttons ---------- */
  document.querySelectorAll('[data-copy]').forEach(function(btn){
    btn.addEventListener('click', function(){
      var target = document.querySelector(btn.getAttribute('data-copy'));
      if(!target) return;
      navigator.clipboard.writeText(target.textContent).then(function(){
        var old = btn.textContent;
        btn.textContent = '[ COPIED ]';
        setTimeout(function(){ btn.textContent = old; }, 1400);
      });
    });
  });

  /* ---------- demo video: nudge autoplay, fall back to tap ---------- */
  var demo = document.querySelector('#live video');
  if(demo){
    // Chrome ignores the muted *attribute* for autoplay policy in some cases;
    // setting the property explicitly is what actually unlocks muted autoplay.
    var tryPlay = function(){ demo.muted = true; var p = demo.play(); if(p && p.catch) p.catch(function(){}); };
    tryPlay();
    document.addEventListener('visibilitychange', tryPlay);
    demo.addEventListener('click', tryPlay);
    // strict environments (gesture-required autoplay): retry on first interaction
    ['pointerdown','keydown','scroll','touchstart'].forEach(function(ev){
      window.addEventListener(ev, function once(){
        window.removeEventListener(ev, once);
        if(demo.paused) tryPlay();
      }, { passive:true });
    });
    if('IntersectionObserver' in window){
      new IntersectionObserver(function(entries){
        if(entries[0].isIntersecting && demo.paused) tryPlay();
      }).observe(demo);
    }
  }

  /* ---------- year ---------- */
  var y = document.getElementById('year');
  if(y) y.textContent = String(new Date().getFullYear());
})();
