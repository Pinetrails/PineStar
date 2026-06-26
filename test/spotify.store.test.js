/* node test/spotify.store.test.js — durable token store + auto-refresh. Offline + deterministic (real temp
   dir; injected fetch + clock). Pairs with sidecar/spotify/store.js. */
'use strict';
const A = require('./_assert.js');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { makeSpotifyStore } = require('../sidecar/spotify/store.js');

const DIR = path.join(os.tmpdir(), 'starnet-spotify-store-test');

function fetchOnce(resp) {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url: String(url), init }); return resp(String(url), init); };
  fn.calls = calls; return fn;
}
function jsonResp(obj, status) { return { ok: (status || 200) < 300, status: status || 200, json: async () => obj }; }

(async () => {
  try { await fsp.rm(DIR, { recursive: true, force: true }); } catch (_) {}
  let T = 1000;
  const now = () => T;

  // ---- A. persist + reload across instances ----
  const noFetch = fetchOnce(() => jsonResp({}));
  const s1 = makeSpotifyStore({ fsp, pathMod: path, dir: DIR, fetchImpl: noFetch, now });
  await s1.setClientId('CID');
  await s1.setTokens({ accessToken: 'AT1', refreshToken: 'RT1', expiresAt: T + 3600000, scope: 'sc' });
  let st = await s1.status();
  A.eq(st.connected, true, 'status connected after setTokens');
  A.eq(st.hasClientId, true, 'status reports clientId');

  const s2 = makeSpotifyStore({ fsp, pathMod: path, dir: DIR, fetchImpl: noFetch, now });   // fresh instance
  const st2 = await s2.status();
  A.eq(st2.connected, true, 'a new store instance loads the persisted session from disk');
  A.eq(await s2.getClientId(), 'CID', 'clientId persisted to disk');

  // ---- B. getAccessToken returns the cached token while it is still valid (no network) ----
  const tok = await s2.getAccessToken();
  A.eq(tok, 'AT1', 'getAccessToken returns the valid cached token');
  A.eq(noFetch.calls.length, 0, 'no refresh network call while the token is valid');

  // ---- C. expired token -> auto refresh via fetch, persists the new token ----
  T = T + 4000000;   // now past expiresAt
  const refetch = fetchOnce((url) => {
    A.ok(url.indexOf('accounts.spotify.com/api/token') >= 0, 'refresh hits the Spotify token endpoint');
    return jsonResp({ access_token: 'AT2', expires_in: 3600, scope: 'sc' });
  });
  const s3 = makeSpotifyStore({ fsp, pathMod: path, dir: DIR, fetchImpl: refetch, now });
  const tok2 = await s3.getAccessToken();
  A.eq(tok2, 'AT2', 'getAccessToken refreshes an expired token');
  A.eq(refetch.calls.length, 1, 'exactly one refresh call');
  A.ok((refetch.calls[0].init.body || '').indexOf('grant_type=refresh_token') >= 0, 'refresh sends the refresh grant');
  A.ok((refetch.calls[0].init.body || '').indexOf('refresh_token=RT1') >= 0, 'refresh sends the stored refresh token');
  // new token persisted
  const s4 = makeSpotifyStore({ fsp, pathMod: path, dir: DIR, fetchImpl: noFetch, now });
  A.eq(await s4.getAccessToken(), 'AT2', 'the refreshed token is persisted to disk');

  // ---- D. invalid_grant (dead refresh token) clears the session ----
  T = T + 4000000;
  const deadFetch = fetchOnce(() => jsonResp({ error: 'invalid_grant' }, 400));
  const s5 = makeSpotifyStore({ fsp, pathMod: path, dir: DIR, fetchImpl: deadFetch, now });
  let reconnect = false; try { await s5.getAccessToken(); } catch (e) { reconnect = /reconnect/i.test(e.message); }
  A.ok(reconnect, 'a dead refresh token surfaces a reconnect error');
  const s6 = makeSpotifyStore({ fsp, pathMod: path, dir: DIR, fetchImpl: noFetch, now });
  A.eq((await s6.status()).connected, false, 'invalid_grant cleared the session on disk');
  A.eq(await s6.getClientId(), 'CID', 'clear() keeps the clientId for easy reconnect');

  // ---- E. not connected -> clean error ----
  try { await fsp.rm(DIR, { recursive: true, force: true }); } catch (_) {}
  const s7 = makeSpotifyStore({ fsp, pathMod: path, dir: DIR, fetchImpl: noFetch, now });
  let notConn = false; try { await s7.getAccessToken(); } catch (e) { notConn = /not connected/i.test(e.message); }
  A.ok(notConn, 'getAccessToken errors clearly when Spotify is not connected');

  try { await fsp.rm(DIR, { recursive: true, force: true }); } catch (_) {}
  A.report('spotify.store.test');
})().catch(e => { console.log('FATAL', e && e.stack || e); process.exit(1); });
