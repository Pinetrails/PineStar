/* live-preview.js — sizes the embedded-app clip. The preview is the REAL app
   (website/app, a verbatim frontend copy booted from a seeded save) rendered in an
   iframe at the app's fixed 1380x900 layout. The .app-clip window shows the station
   camera panel (666x744 at offset 283,88); this keeps --appk = clipWidth/666 so the
   clip scales with the column while the app inside stays at its native layout. */
(function(){
  'use strict';
  var clip = document.querySelector('.app-clip');
  if (!clip) return;
  function size(){
    var k = clip.clientWidth / 666;
    clip.style.setProperty('--appk', String(k));
  }
  size();
  window.addEventListener('resize', size);
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(size).observe(clip);
})();
