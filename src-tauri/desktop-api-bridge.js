(function () {
  'use strict';

  var sidecar = window.__STARNET_API__;
  var token = window.__STARNET_API_TOKEN__;
  var appOrigin = window.location.origin;
  var originalFetch = window.fetch.bind(window);

  function isApiPath(pathname) {
    return pathname === '/api' || pathname.indexOf('/api/') === 0;
  }

  function routedUrl(input) {
    if (typeof input === 'string') {
      return isApiPath(input.split(/[?#]/, 1)[0]) ? sidecar + input : null;
    }
    if (typeof Request !== 'undefined' && input instanceof Request) {
      var parsed = new URL(input.url);
      return parsed.origin === appOrigin && isApiPath(parsed.pathname)
        ? sidecar + parsed.pathname + parsed.search + parsed.hash
        : null;
    }
    return null;
  }

  window.fetch = function (input, init) {
    var target = routedUrl(input);
    if (!target) return originalFetch(input, init);

    var options = init ? Object.assign({}, init) : {};
    var headers = new Headers(
      Object.prototype.hasOwnProperty.call(options, 'headers')
        ? options.headers
        : (typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined)
    );
    headers.set('X-StarNet-Token', token);
    options.headers = headers;

    if (typeof Request !== 'undefined' && input instanceof Request) {
      return originalFetch(new Request(target, input), options);
    }
    return originalFetch(target, options);
  };
}());
