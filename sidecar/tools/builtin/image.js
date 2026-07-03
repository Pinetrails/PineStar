/* sidecar/tools/builtin/image.js — the STUDIO capability: image_generate(prompt) + image_analyze(image).

   Both skills ride the SAME BYOK OpenRouter key the agent already uses, hitting the chat-completions
   endpoint — no new provider, no new key, fully additive (matches the web.js pattern exactly):

     image_generate  : POST /chat/completions with modalities:['image','text']. The model returns a
                       base64 data-URL PNG in choices[0].message.images[]; we decode it and save it into
                       the agent's JAILED workspace (same guard as fs.write), emit a 'deliverable' event so
                       the UI shows it, and hand back the /api/file?agent=…&path=… viewer URL.
                       Default model: google/gemini-2.5-flash-image (override via args.model — e.g.
                       black-forest-labs/flux.2-pro, recraft/recraft-v4).
     image_analyze   : POST /chat/completions to a VISION model with a multi-part user message
                       [{type:'text'},{type:'image_url'}]. The image is either a workspace-relative path
                       (read + base64-encoded into a data URL) or a public http(s) URL (passed straight
                       through — OpenRouter fetches it server-side). Returns the model's text answer.

   makeImageTools({ openrouter:{apiKey, model?}, fsp, pathMod, root, fetchImpl?, imageModel?, visionModel? })
     -> { generateTool, analyzeTool, register(reg), _internals }

   Node 18+ (global fetch). No dependencies. Reuses the fs.js workspace jail so a generated/analyzed path
   can never escape <root>/<agentId>/. */
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./fs.js'));
  else { root.SK = root.SK || {}; root.SK.tools = root.SK.tools || {}; (root.SK.tools.builtin = root.SK.tools.builtin || {}).image = factory(root.SK.tools.builtin.fs); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (fsMod) {
  'use strict';

  const OR_URL = 'https://openrouter.ai/api/v1/chat/completions';
  const DEFAULT_IMAGE_MODEL  = 'google/gemini-2.5-flash-image';   // text->image; override per call via args.model
  const DEFAULT_VISION_MODEL = 'google/gemini-2.5-flash';         // image->text (multimodal); override via args.model
  const GEN_TIMEOUT_MS    = 110000;   // image generation can take 10-40s; the tool-level timeout sits above this
  const ANALYZE_TIMEOUT_MS = 55000;
  const ANALYZE_RETURN_CHARS = 8000;
  const MAX_IMAGE_BYTES   = 8 * 1024 * 1024;   // refuse to read a workspace image larger than this for analysis

  const EXT_BY_MIME = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };
  const MIME_BY_EXT = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

  function withTimeout(promiseFactory, ms) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    return Promise.resolve(promiseFactory(ctrl.signal)).finally(() => clearTimeout(t));
  }

  // Pull the first image (data-URL or http URL) out of an OpenRouter chat-completions response. Providers vary:
  // most return choices[0].message.images[] = [{type:'image_url', image_url:{url}}], but some nest the image in
  // message.content[] parts, and the url field is sometimes a bare string. Be liberal in what we accept.
  function imageUrlFromPart(p) {
    if (!p) return '';
    if (typeof p === 'string') return p;
    if (p.image_url) return (typeof p.image_url === 'string') ? p.image_url : (p.image_url.url || '');
    if (p.url) return p.url;
    if (p.b64_json) return 'data:image/png;base64,' + p.b64_json;
    return '';
  }
  function parseImageFromResponse(data) {
    const msg = data && data.choices && data.choices[0] && data.choices[0].message;
    if (!msg) return '';
    if (Array.isArray(msg.images)) { for (const im of msg.images) { const u = imageUrlFromPart(im); if (u) return u; } }
    if (Array.isArray(msg.content)) { for (const p of msg.content) { if (p && (p.type === 'image_url' || p.type === 'output_image' || p.image_url || p.url)) { const u = imageUrlFromPart(p); if (u) return u; } } }
    return '';
  }
  // Any plain text the model emitted alongside the image (e.g. a caption / refusal). Used for the tool summary.
  function textFromResponse(data) {
    const msg = data && data.choices && data.choices[0] && data.choices[0].message;
    if (!msg) return '';
    if (typeof msg.content === 'string') return msg.content.trim();
    if (Array.isArray(msg.content)) return msg.content.filter(p => p && p.type === 'text').map(p => p.text || '').join(' ').trim();
    return '';
  }

  // "data:image/png;base64,AAAA" -> { mime, buffer }. Throws on a malformed/oversized data URL.
  function dataUrlToBuffer(url) {
    const m = /^data:([^;,]+)?(;base64)?,(.*)$/is.exec(String(url || ''));
    if (!m) throw new Error('not a data URL');
    const mime = (m[1] || 'image/png').toLowerCase();
    const isB64 = !!m[2];
    const buf = isB64 ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8');
    if (!buf.length) throw new Error('empty image data');
    return { mime, buffer: buf };
  }

  function extOf(P, p) { return String(P.extname(p) || '').toLowerCase(); }

  function makeImageTools(deps) {
    deps = deps || {};
    const or = deps.openrouter || {};
    const apiKey = or.apiKey || deps.apiKey || '';
    const fsp = deps.fsp, P = deps.pathMod, ROOT = deps.root;
    if (!fsp || !P || !ROOT) throw new Error('image.js requires { fsp, pathMod, root }');
    const doFetch = deps.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    if (!doFetch) throw new Error('image.js requires global fetch (Node 18+) or deps.fetchImpl');
    const IMAGE_MODEL  = deps.imageModel  || DEFAULT_IMAGE_MODEL;
    const VISION_MODEL = deps.visionModel || or.model || DEFAULT_VISION_MODEL;
    // reuse the ONE workspace jail (fs.js) so generated/analyzed paths can't escape the agent's directory
    const jail = fsMod.makeFsTools({ fsp, pathMod: P, root: ROOT })._internals;

    function emitDeliverable(ctx, aid, rel) {
      if (!ctx || typeof ctx.emit !== 'function') return;
      const d = { id: 'img_' + String(rel).replace(/[^A-Za-z0-9_.-]/g, '_'), agentId: aid, kind: 'image', title: String(rel) };
      if (ctx.room) d.room = ctx.room;
      ctx.emit('deliverable', d);
    }

    async function orPost(body, timeoutMs) {
      if (!apiKey) throw new Error('no OpenRouter API key configured — connect a key first');
      const res = await withTimeout(signal => doFetch(OR_URL, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://starnet.local', 'X-Title': 'STARNET' },
        body: JSON.stringify(body),
        signal
      }).then(async r => ({ status: r.status, json: await r.json().catch(() => null), text: null })), timeoutMs);
      if (res.status < 200 || res.status >= 300) {
        const errMsg = res.json && res.json.error && (res.json.error.message || res.json.error) || ('http ' + res.status);
        throw new Error('OpenRouter ' + res.status + ': ' + (typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg)));
      }
      return res.json || {};
    }

    // ---------------- image_generate ----------------
    const generateTool = {
      name: 'image_generate', capability: 'studio', scope: 'write', requiresConsent: true, timeoutMs: GEN_TIMEOUT_MS + 15000,
      description: 'Generate an image from a text prompt and SAVE it into your workspace (returns the saved path + a viewer URL). ' +
        'Use for any "draw / create / generate an image of …" request. Optional "model" picks the image model ' +
        '(default google/gemini-2.5-flash-image; also e.g. black-forest-labs/flux.2-pro). Optional "path" sets the output filename.',
      schema: { type: 'object', required: ['prompt'], properties: {
        prompt: { type: 'string' },
        model: { type: 'string' },
        path: { type: 'string' }
      } },
      run: async (args, ctx) => {
        const aid = (ctx && ctx.agentId) || 'agent';
        const prompt = String(args.prompt || '').trim();
        if (!prompt) throw new Error('prompt is required');
        const model = String(args.model || IMAGE_MODEL);
        const data = await orPost({
          model,
          messages: [{ role: 'user', content: prompt }],
          modalities: ['image', 'text']
        }, GEN_TIMEOUT_MS);
        const url = parseImageFromResponse(data);
        if (!url) {
          const txt = textFromResponse(data);
          throw new Error('model returned no image' + (txt ? ' (' + txt.slice(0, 200) + ')' : '') + ' — is "' + model + '" an image-output model?');
        }
        // materialize the bytes (data-URL decode, or fetch a hosted URL)
        let mime, buffer;
        if (/^data:/i.test(url)) { ({ mime, buffer } = dataUrlToBuffer(url)); }
        else if (/^https?:\/\//i.test(url)) {
          const r = await withTimeout(signal => doFetch(url, { signal }).then(async rr => ({ status: rr.status, ab: await rr.arrayBuffer(), ct: rr.headers.get('content-type') || 'image/png' })), 30000);
          if (r.status < 200 || r.status >= 300) throw new Error('could not download generated image (http ' + r.status + ')');
          mime = String(r.ct).split(';')[0].toLowerCase(); buffer = Buffer.from(r.ab);
        } else throw new Error('unrecognized image reference from model');
        if (buffer.length > MAX_IMAGE_BYTES) throw new Error('generated image too large (' + buffer.length + ' bytes)');
        // choose a jailed output path (default images/gen-<rand><ext>)
        const ext = EXT_BY_MIME[mime] || '.png';
        let rel = String(args.path || '').trim();
        if (rel) { if (!/\.[a-z0-9]+$/i.test(rel)) rel += ext; }
        else {
          // content-addressed default name: deterministic (no ambient rng — see lint-determinism) AND
          // collision-resistant, so re-generating the same bytes is idempotent rather than piling up files.
          const h = require('node:crypto').createHash('sha1').update(buffer).digest('hex').slice(0, 12);
          rel = 'images/gen-' + h + ext;
        }
        const { abs } = await jail.resolveInside(aid, rel);   // throws on jail escape / abs / '..'
        await fsp.mkdir(P.dirname(abs), { recursive: true });
        await fsp.writeFile(abs, buffer);
        emitDeliverable(ctx, aid, rel);
        const viewer = '/api/file?agent=' + encodeURIComponent(aid) + '&path=' + encodeURIComponent(rel);
        const caption = textFromResponse(data);
        const kb = (buffer.length / 1024).toFixed(0) + ' KB';
        return {
          content: 'Generated and saved ' + rel + ' (' + kb + ', ' + mime + ', model ' + model + ').\nView: ' + viewer + (caption ? '\nModel note: ' + caption : ''),
          summary: 'image → ' + rel
        };
      }
    };

    // ---------------- image_analyze ----------------
    async function imageToUrl(aid, image) {
      const s = String(image || '').trim();
      if (!s) throw new Error('image is required (a workspace path or an http(s) URL)');
      if (/^data:/i.test(s)) return s;                          // already a data URL
      if (/^https?:\/\//i.test(s)) return s;                    // public URL — OpenRouter fetches it server-side
      if (/^[a-z]+:\/\//i.test(s)) throw new Error('only http(s) URLs, data URLs, or workspace paths are allowed');
      // else: a workspace-relative path -> read + base64
      const { abs } = await jail.resolveInside(aid, s);
      let buf;
      try { buf = await fsp.readFile(abs); }
      catch (e) { if (e && e.code === 'ENOENT') throw new Error('no such file in workspace: ' + s); throw e; }
      if (buf.length > MAX_IMAGE_BYTES) throw new Error('image too large to analyze (' + buf.length + ' bytes)');
      const mime = MIME_BY_EXT[extOf(P, abs)] || 'image/png';
      return 'data:' + mime + ';base64,' + buf.toString('base64');
    }

    // Core vision call, reusable by other tools (e.g. browser.vision). `url` is a data/http(s)
    // image URL; returns the model's answer text (truncated). Throws with a clear message when
    // no key is configured (orPost) so the caller can report honestly rather than fake success.
    async function analyzeImageUrl(url, question, modelOverride) {
      const model = String(modelOverride || VISION_MODEL);
      const q = String(question || '').trim() || 'Describe this image in detail.';
      const data = await orPost({
        model,
        messages: [{ role: 'user', content: [
          { type: 'text', text: q },     // text first, then image — OpenRouter's recommended order
          { type: 'image_url', image_url: { url } }
        ] }]
      }, ANALYZE_TIMEOUT_MS);
      const text = textFromResponse(data);
      if (!text) throw new Error('vision model "' + model + '" returned no text — is it vision-capable?');
      return text.length > ANALYZE_RETURN_CHARS ? text.slice(0, ANALYZE_RETURN_CHARS) + '\n…[truncated]' : text;
    }

    const analyzeTool = {
      name: 'image_analyze', capability: 'studio', scope: 'read', requiresConsent: false, timeoutMs: ANALYZE_TIMEOUT_MS + 15000,
      description: 'Look at an image and answer a question about it (vision). "image" is EITHER a file in your workspace ' +
        '(e.g. "images/gen-ab12cd.png") OR a public http(s) image URL. Optional "prompt" is the question (default: a ' +
        'detailed description). Optional "model" overrides the vision model (default google/gemini-2.5-flash).',
      schema: { type: 'object', required: ['image'], properties: {
        image: { type: 'string' },
        prompt: { type: 'string' },
        model: { type: 'string' }
      } },
      run: async (args, ctx) => {
        const aid = (ctx && ctx.agentId) || 'agent';
        const url = await imageToUrl(aid, args.image);
        const out = await analyzeImageUrl(url, args.prompt, args.model);
        return { content: out, summary: 'analyzed image (' + out.length + ' chars)' };
      }
    };

    // A vision callback for makeBrowserTools: takes a base64 PNG (CDP screenshot) + question,
    // returns the model's answer. Honest failure (no key) propagates as a thrown Error which
    // browser.vision converts to an 'vision unavailable' result.
    const hasVision = !!apiKey;
    async function browserVision({ imageBase64, question }) {
      const url = 'data:image/png;base64,' + String(imageBase64 || '');
      return analyzeImageUrl(url, question);
    }

    return {
      generateTool, analyzeTool, analyzeImageUrl, browserVision, hasVision,
      _internals: { parseImageFromResponse, textFromResponse, dataUrlToBuffer, imageUrlFromPart, imageToUrl, analyzeImageUrl },
      register(reg) { reg.register(generateTool); reg.register(analyzeTool); return reg; }
    };
  }

  return { makeImageTools };
});
