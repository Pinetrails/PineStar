/* sidecar/mcp/catalog.js — the CURATED connector catalog: a vetted, categorized list of remote MCP
   servers a Commander can one-click add, layered on the generic connector manager (mcp/manager.js).

   This module is PURE DATA + selectors — no I/O, no Date / Math.random — the honest "what can I plug in"
   list. Adding a connector is a data ROW here, never new code, exactly like dropping a skills/library/*.md
   recipe. Installing an entry only pre-fills the EXISTING `POST /api/connectors` upsert (id / transport /
   url / label / token); the manager then really connects it and reports honest live state (green up /
   amber down / red error). So a catalog row is an OFFER — never a claim that it is connected. Truthful
   telemetry: the catalog never asserts a tool exists; the real tools/list arrives only after the manager
   handshakes the live server.

   authType — drives the UI tier AND which entries are installable TODAY:
     'none'   — no credentials; connects immediately (the zero-setup tier; our live-verified demo path).
     'apikey' — paste a bearer API key / token (works today via the manager's existing `token` field).
     'oauth'  — needs an interactive OAuth sign-in (the generic RFC 9728/8414/7591 + PKCE dynamic-client-
                registration flow in mcp/oauth.js). LIVE: the panel shows a SIGN IN button (gated on
                authType==='oauth'). `installable` stays FALSE for oauth BY DESIGN — an oauth connector is stood
                up by its own start/callback sign-in flow, not a one-click direct upsert, so installConfig()
                returns null for it. A url-less oauth entry (reached via an aggregator) carries `via` — the
                catalog id of the aggregator that reaches it — and the panel renders a live "VIA <name>" jump
                to that card (never a mute dead button).

   transport is always 'http' — the manager's http transport speaks MCP "Streamable HTTP" (POST JSON-RPC,
   response is JSON or an SSE stream). We deliberately seed only Streamable-HTTP `/mcp`-style endpoints and
   NEVER the legacy GET-`/sse` dual-endpoint servers that transport can't drive (listing one would be a lie
   the moment a user clicked it). Remote-first matches CONNECTORS_MCP_PLAN; stdio/npx entries are excluded
   until the child-process jail is a first-class connector transport.

   `official` = a first-party server run by the vendor it integrates (Stripe's own Stripe server), vs a
   community/third-party host. The panel badges it so a Commander can prefer first-party. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; (root.SK.mcp = root.SK.mcp || {}).catalog = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // the auth tiers stood up by a direct one-click upsert (POST /api/connectors). OAuth is deliberately NOT here —
  // an oauth connector is stood up by its own sign-in flow (oauth/start -> callback), so it is never "installable"
  // and installConfig() returns null for it; the panel drives it via a SIGN IN button instead.
  const INSTALLABLE_AUTH = ['none', 'apikey'];

  // Stable category ORDER for the browse UI (entries within a category sort by name). A category not listed
  // here still renders — it just sorts last, alphabetically — so a new-category row never needs a code edit.
  const CATEGORY_ORDER = [
    'Docs & Knowledge', 'Search & Research', 'Compute & Data', 'Developer Tools',
    'Automation', 'Social', 'Productivity', 'Design', 'Payments & Finance', 'CRM & Sales', 'Marketing'
  ];

  /* The seed. Every endpoint below is a Streamable-HTTP `/mcp`-style URL. The `none` tier is verified to
     connect with no credentials; `apikey` uses the manager's bearer `token` field; `oauth` is listed-but-
     gated until the OAuth flow ships. Grow this list by adding rows — that is the whole extension model. */
  const CATALOG = [
    // ── Docs & Knowledge — zero-setup, no auth ────────────────────────────────────────────────────────
    { id: 'deepwiki', name: 'DeepWiki', category: 'Docs & Knowledge', authType: 'none', transport: 'http',
      url: 'https://mcp.deepwiki.com/mcp', official: true, homepage: 'https://deepwiki.com',
      blurb: 'Ask natural-language questions about any public GitHub repository — indexed docs, structure, and code.' },
    { id: 'context7', name: 'Context7', category: 'Docs & Knowledge', authType: 'none', transport: 'http',
      url: 'https://mcp.context7.com/mcp', official: true, homepage: 'https://context7.com',
      blurb: 'Pulls up-to-date, version-specific docs and code examples for thousands of libraries and frameworks.' },
    { id: 'huggingface', name: 'Hugging Face', category: 'Docs & Knowledge', authType: 'none', transport: 'http',
      url: 'https://hf.co/mcp', official: true, homepage: 'https://huggingface.co',
      blurb: 'Search models, datasets, and Spaces on the Hugging Face Hub, and read model cards.' },
    { id: 'aws-knowledge', name: 'AWS Knowledge', category: 'Docs & Knowledge', authType: 'none', transport: 'http',
      url: 'https://knowledge-mcp.global.api.aws', official: true, homepage: 'https://aws.amazon.com',
      blurb: 'Authoritative AWS documentation, API references, and architectural guidance.' },
    { id: 'gitmcp', name: 'GitMCP', category: 'Docs & Knowledge', authType: 'none', transport: 'http',
      url: 'https://gitmcp.io/docs', official: false, homepage: 'https://gitmcp.io',
      blurb: 'Turns any GitHub project into a docs assistant the agent can query for accurate, current answers.' },

    // ── Search & Research (Exa is zero-setup; Tavily takes a key) ─────────────────────────────────────
    { id: 'exa', name: 'Exa Search', category: 'Search & Research', authType: 'none', transport: 'http',
      url: 'https://mcp.exa.ai/mcp', official: true, homepage: 'https://exa.ai',
      blurb: 'Neural web search built for AI — higher-signal results and full-page content extraction.' },
    { id: 'tavily', name: 'Tavily', category: 'Search & Research', authType: 'apikey', transport: 'http',
      url: 'https://mcp.tavily.com/mcp', official: true, homepage: 'https://tavily.com',
      blurb: 'AI-native web search + page extraction tuned for agents. Paste your Tavily API key.' },

    // ── Compute & Data — zero-setup ───────────────────────────────────────────────────────────────────
    { id: 'wolfram', name: 'Wolfram', category: 'Compute & Data', authType: 'none', transport: 'http',
      url: 'https://agenttools.wolfram.com/mcp', official: true, homepage: 'https://wolfram.com',
      blurb: 'Wolfram|Alpha computation — math, unit conversions, data, and step-by-step answers.' },

    // ── Automation — one API key, enormous reach ──────────────────────────────────────────────────────
    { id: 'zapier', name: 'Zapier', category: 'Automation', authType: 'apikey', transport: 'http',
      url: 'https://mcp.zapier.com/api/mcp/mcp', official: true, homepage: 'https://zapier.com',
      blurb: 'Bridge to 7,000+ apps — including Gmail, Google Calendar, Drive, Sheets, and Slack — through one key.' },
    { id: 'apify', name: 'Apify', category: 'Automation', authType: 'apikey', transport: 'http',
      url: 'https://mcp.apify.com', official: true, homepage: 'https://apify.com',
      blurb: 'Run web-scraping and automation Actors, and pull structured data from the web.' },
    { id: 'composio', name: 'Composio', category: 'Automation', authType: 'apikey', transport: 'http',
      url: 'https://connect.composio.dev/mcp', official: true, homepage: 'https://composio.dev',
      blurb: 'One key bridges 500+ apps — X, Slack, Gmail, Google Drive, Notion, GitHub, and more. The fastest way to reach the platforms that otherwise need their own sign-in.' },

    // ── Social — paste an API key (read access); posting needs OAuth ───────────────────────────────────
    { id: 'x-twitter', name: 'X (Twitter)', category: 'Social', authType: 'apikey', transport: 'http',
      url: 'https://api.x.com/mcp', official: true, homepage: 'https://x.com',
      blurb: "X's official server — search and read posts, profiles, and timelines with your X API Bearer token. This read-only token connector does not grant posting (that needs X's write OAuth scope)." },

    // ── Payments & Finance — one API key ──────────────────────────────────────────────────────────────
    { id: 'stripe', name: 'Stripe', category: 'Payments & Finance', authType: 'apikey', transport: 'http',
      url: 'https://mcp.stripe.com/', official: true, homepage: 'https://stripe.com',
      blurb: 'Query customers, payments, invoices, and subscriptions with a restricted Stripe API key.' },

    // ── CRM & Sales — one API key ─────────────────────────────────────────────────────────────────────
    { id: 'hubspot', name: 'HubSpot', category: 'CRM & Sales', authType: 'apikey', transport: 'http',
      url: 'https://app.hubspot.com/mcp/v1/http', official: true, homepage: 'https://hubspot.com',
      blurb: 'Read and update CRM contacts, companies, deals, and tickets with a private-app token.' },

    // ── OAuth tier — LISTED but not installable until the OAuth slice ships (honest, not a dead click) ──
    /* `via` (url-less oauth entries only): the catalog id of the AGGREGATOR that reaches this platform today.
       The panel renders it as a live "VIA <name>" jump to that card instead of a mute disabled button. */
    { id: 'google-workspace', name: 'Google Workspace', category: 'Productivity', authType: 'oauth', transport: 'http',
      url: '', official: true, homepage: 'https://workspace.google.com', via: 'zapier',
      blurb: 'Gmail, Calendar, Drive, Docs, and Sheets. Google ships no public MCP endpoint yet — reach it today through the Zapier connector (one API key).' },
    { id: 'notion', name: 'Notion', category: 'Productivity', authType: 'oauth', transport: 'http',
      url: 'https://mcp.notion.com/mcp', official: true, homepage: 'https://notion.so',
      blurb: 'Search, read, and create Notion pages and databases. Needs Notion sign-in (OAuth).' },
    { id: 'linear', name: 'Linear', category: 'Productivity', authType: 'oauth', transport: 'http',
      url: 'https://mcp.linear.app/mcp', official: true, homepage: 'https://linear.app',
      blurb: 'Create, search, and update Linear issues and projects. Needs Linear sign-in (OAuth).' },
    { id: 'atlassian', name: 'Jira & Confluence', category: 'Productivity', authType: 'oauth', transport: 'http',
      url: '', official: true, homepage: 'https://atlassian.com', via: 'zapier',
      blurb: 'Atlassian Jira issues and Confluence pages. Their endpoint speaks Basic auth our transport can\'t drive — reach it today through the Zapier connector (one API key).' },
    /* apikey, NOT oauth: github.com/login/oauth exposes no RFC 7591 dynamic registration (live-probed
       2026-07-18 — discovery succeeds but registration_endpoint is absent), so our DCR sign-in flow can
       never complete against it. A PAT as `Authorization: Bearer` is the documented remote-server path. */
    { id: 'github', name: 'GitHub', category: 'Developer Tools', authType: 'apikey', transport: 'http',
      url: 'https://api.githubcopilot.com/mcp', official: true, homepage: 'https://github.com',
      blurb: 'Issues, pull requests, code search, and Actions across your repos. Paste a GitHub personal access token (github.com → Settings → Developer settings).' },
    { id: 'sentry', name: 'Sentry', category: 'Developer Tools', authType: 'oauth', transport: 'http',
      url: 'https://mcp.sentry.dev/mcp', official: true, homepage: 'https://sentry.io',
      blurb: 'Inspect errors, issues, and releases from your Sentry projects. Needs Sentry sign-in (OAuth).' },
    { id: 'supabase', name: 'Supabase', category: 'Developer Tools', authType: 'oauth', transport: 'http',
      url: 'https://mcp.supabase.com/mcp', official: true, homepage: 'https://supabase.com',
      blurb: 'Query your Postgres database and manage Supabase projects. Needs Supabase sign-in (OAuth).' },

    /* ── WAVE 2 (all live-verified 2026-07-06): open docs, bearer-key SaaS, and OAuth+DCR connectors whose
       dynamic registration was confirmed to actually mint a client. Skipped (would lie): figma (advertises DCR
       but 403s it), atlassian (Basic-auth not bearer), plaid (no standard discovery). ── */
    // Docs & Knowledge — zero-setup (connect keyless, tools discovered)
    { id: 'cloudflare-docs', name: 'Cloudflare Docs', category: 'Docs & Knowledge', authType: 'none', transport: 'http',
      url: 'https://docs.mcp.cloudflare.com/mcp', official: true, homepage: 'https://developers.cloudflare.com',
      blurb: "Search Cloudflare's product documentation and developer guides." },
    { id: 'microsoft-learn', name: 'Microsoft Learn', category: 'Docs & Knowledge', authType: 'none', transport: 'http',
      url: 'https://learn.microsoft.com/api/mcp', official: true, homepage: 'https://learn.microsoft.com',
      blurb: 'Search Microsoft Learn docs for Azure, .NET, Microsoft 365, and more.' },
    // Developer Tools
    { id: 'gitlab', name: 'GitLab', category: 'Developer Tools', authType: 'oauth', transport: 'http',
      url: 'https://gitlab.com/api/v4/mcp', official: true, homepage: 'https://gitlab.com',
      blurb: 'Issues, merge requests, and pipelines across your GitLab projects. Needs GitLab sign-in (OAuth).' },
    { id: 'vercel', name: 'Vercel', category: 'Developer Tools', authType: 'oauth', transport: 'http',
      url: 'https://mcp.vercel.com/', official: true, homepage: 'https://vercel.com',
      blurb: 'Manage Vercel projects, deployments, and logs. Needs Vercel sign-in (OAuth).' },
    { id: 'netlify', name: 'Netlify', category: 'Developer Tools', authType: 'oauth', transport: 'http',
      url: 'https://netlify-mcp.netlify.app/mcp', official: true, homepage: 'https://netlify.com',
      blurb: 'Deploy and manage Netlify sites. Needs Netlify sign-in (OAuth).' },
    { id: 'neon', name: 'Neon', category: 'Developer Tools', authType: 'oauth', transport: 'http',
      url: 'https://mcp.neon.tech/mcp', official: true, homepage: 'https://neon.tech',
      blurb: 'Query and manage your Neon serverless Postgres. Needs Neon sign-in (OAuth).' },
    { id: 'prisma', name: 'Prisma', category: 'Developer Tools', authType: 'apikey', transport: 'http',
      url: 'https://mcp.prisma.io/mcp', official: true, homepage: 'https://prisma.io',
      blurb: 'Manage Prisma Postgres databases. Paste your Prisma API key.' },
    // Productivity
    { id: 'airtable', name: 'Airtable', category: 'Productivity', authType: 'apikey', transport: 'http',
      url: 'https://mcp.airtable.com/mcp', official: true, homepage: 'https://airtable.com',
      blurb: 'Read and write Airtable bases and records. Paste an Airtable personal access token.' },
    { id: 'asana', name: 'Asana', category: 'Productivity', authType: 'oauth', transport: 'http',
      url: 'https://mcp.asana.com/mcp', official: true, homepage: 'https://asana.com',
      blurb: 'Create and track Asana tasks and projects. Needs Asana sign-in (OAuth).' },
    { id: 'monday', name: 'monday.com', category: 'Productivity', authType: 'oauth', transport: 'http',
      url: 'https://mcp.monday.com/mcp', official: true, homepage: 'https://monday.com',
      blurb: 'Create and update monday.com boards and items. Needs monday.com sign-in (OAuth).' },
    // Design
    { id: 'canva', name: 'Canva', category: 'Design', authType: 'oauth', transport: 'http',
      url: 'https://mcp.canva.com/mcp', official: true, homepage: 'https://canva.com',
      blurb: 'Generate and manage Canva designs. Needs Canva sign-in (OAuth).' },
    { id: 'webflow', name: 'Webflow', category: 'Design', authType: 'oauth', transport: 'http',
      url: 'https://mcp.webflow.com/mcp', official: true, homepage: 'https://webflow.com',
      blurb: 'Manage Webflow sites, CMS collections, and content. Needs Webflow sign-in (OAuth).' },
    { id: 'wix', name: 'Wix', category: 'Design', authType: 'oauth', transport: 'http',
      url: 'https://mcp.wix.com/mcp', official: true, homepage: 'https://wix.com',
      blurb: 'Manage Wix sites, stores, and bookings. Needs Wix sign-in (OAuth).' },
    // Payments & Finance
    { id: 'paypal', name: 'PayPal', category: 'Payments & Finance', authType: 'oauth', transport: 'http',
      url: 'https://mcp.paypal.com/mcp', official: true, homepage: 'https://paypal.com',
      blurb: 'Create invoices and query PayPal orders and payments. Needs PayPal sign-in (OAuth).' },
    { id: 'square', name: 'Square', category: 'Payments & Finance', authType: 'oauth', transport: 'http',
      url: 'https://mcp.squareup.com/mcp', official: true, homepage: 'https://squareup.com',
      blurb: 'Payments, catalog, and orders on Square. Needs Square sign-in (OAuth).' },
    // CRM & Sales
    { id: 'intercom', name: 'Intercom', category: 'CRM & Sales', authType: 'apikey', transport: 'http',
      url: 'https://mcp.intercom.com/mcp', official: true, homepage: 'https://intercom.com',
      blurb: 'Search Intercom conversations, contacts, and articles. Paste an Intercom access token.' }
  ];

  // ── selectors (pure) ────────────────────────────────────────────────────────────────────────────────

  function isInstallable(entry) { return !!entry && INSTALLABLE_AUTH.indexOf(entry.authType) >= 0; }

  // a defensive clone so callers (and the JSON route) can never mutate the frozen seed.
  function cloneEntry(e) {
    return {
      id: e.id, name: e.name, category: e.category, authType: e.authType, transport: e.transport,
      url: e.url || '', official: !!e.official, homepage: e.homepage || '', blurb: e.blurb || '',
      via: e.via || '', installable: isInstallable(e)
    };
  }

  function list() { return CATALOG.map(cloneEntry); }
  function get(id) { const e = CATALOG.find(c => c.id === String(id)); return e ? cloneEntry(e) : null; }
  function ids() { return CATALOG.map(c => c.id); }

  // stable category order: known categories in CATEGORY_ORDER first, then any extras alphabetically.
  function categories() {
    const seen = [];
    for (const c of CATALOG) if (seen.indexOf(c.category) < 0) seen.push(c.category);
    return seen.slice().sort((a, b) => {
      const ia = CATEGORY_ORDER.indexOf(a), ib = CATEGORY_ORDER.indexOf(b);
      if (ia >= 0 && ib >= 0) return ia - ib;
      if (ia >= 0) return -1;
      if (ib >= 0) return 1;
      return a.localeCompare(b);
    });
  }

  function normUrl(u) { return String(u == null ? '' : u).trim().toLowerCase().replace(/\/+$/, ''); }

  // the browse payload: entries annotated with `installed` from the live connector configs, grouped by category.
  // `installed` accepts an iterable of ids (back-compat) OR of {id,url}. An entry is installed only when a config
  // shares its id AND (the entry has no canonical url, OR a config with that id also matches the entry's url) — so a
  // manually-added connector that merely REUSES a catalog id but points at a foreign URL never flips the vetted
  // vendor card to ADDED (truthful telemetry).
  function browse(installed) {
    const byId = new Map();   // id -> Set<normUrl> of configured urls, or null = "id present, match on id alone"
    const add = (x) => {
      if (x == null) return;
      if (typeof x === 'string') { if (!byId.has(x)) byId.set(x, null); return; }
      const id = x.id; if (!id) return;
      const u = normUrl(x.url);
      if (!byId.has(id)) byId.set(id, u ? new Set([u]) : null);
      else { const cur = byId.get(id); if (cur && u) cur.add(u); }   // a later id-only config leaves it id-only
    };
    if (installed && typeof installed.forEach === 'function') installed.forEach(add);
    const isInstalled = (e) => {
      if (!byId.has(e.id)) return false;
      const urls = byId.get(e.id);
      if (!urls) return true;      // id-only info (back-compat / stdio) — best we can do
      if (!e.url) return true;     // catalog entry has no canonical url to disambiguate
      return urls.has(normUrl(e.url));
    };
    const entries = CATALOG.map(e => { const c = cloneEntry(e); c.installed = isInstalled(c); return c; });
    const order = categories();
    entries.sort((a, b) => (order.indexOf(a.category) - order.indexOf(b.category)) || a.name.localeCompare(b.name));
    const groups = order.map(cat => ({ category: cat, connectors: entries.filter(e => e.category === cat) }));
    return { categories: order, groups: groups, connectors: entries };
  }

  // the fields a catalog install hands to POST /api/connectors (never a token — the user supplies that).
  // Returns null for an entry that isn't installable today (oauth) so a caller can't accidentally push one.
  function installConfig(id) {
    const e = get(id);
    if (!e || !e.installable) return null;
    return { id: e.id, transport: e.transport, url: e.url, label: e.name, enabled: true };
  }

  return {
    list, get, ids, categories, browse, installConfig, isInstallable,
    INSTALLABLE_AUTH: INSTALLABLE_AUTH.slice(),
    _internals: { CATALOG, CATEGORY_ORDER, cloneEntry }
  };
});
