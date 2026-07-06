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
     'oauth'  — needs an interactive OAuth sign-in flow. NOT wired yet, so these are LISTED but NOT
                installable — the panel shows them as "needs sign-in (coming soon)" rather than letting a
                click fail with a 401. When the OAuth slice lands, flip them installable by widening
                INSTALLABLE_AUTH; no data change needed.

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

  // the auth tiers the connector manager can actually stand up TODAY (no OAuth flow yet). Widen this when
  // the OAuth slice lands — the oauth rows below become installable with zero data change.
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
      blurb: "X's official server — search and read posts, profiles, and timelines with your X API Bearer token. Posting needs OAuth (coming soon)." },

    // ── Payments & Finance — one API key ──────────────────────────────────────────────────────────────
    { id: 'stripe', name: 'Stripe', category: 'Payments & Finance', authType: 'apikey', transport: 'http',
      url: 'https://mcp.stripe.com/', official: true, homepage: 'https://stripe.com',
      blurb: 'Query customers, payments, invoices, and subscriptions with a restricted Stripe API key.' },

    // ── CRM & Sales — one API key ─────────────────────────────────────────────────────────────────────
    { id: 'hubspot', name: 'HubSpot', category: 'CRM & Sales', authType: 'apikey', transport: 'http',
      url: 'https://app.hubspot.com/mcp/v1/http', official: true, homepage: 'https://hubspot.com',
      blurb: 'Read and update CRM contacts, companies, deals, and tickets with a private-app token.' },

    // ── OAuth tier — LISTED but not installable until the OAuth slice ships (honest, not a dead click) ──
    { id: 'google-workspace', name: 'Google Workspace', category: 'Productivity', authType: 'oauth', transport: 'http',
      url: '', official: true, homepage: 'https://workspace.google.com',
      blurb: 'Gmail, Calendar, Drive, Docs, and Sheets. Needs Google sign-in (OAuth) — available today via the Zapier connector.' },
    { id: 'notion', name: 'Notion', category: 'Productivity', authType: 'oauth', transport: 'http',
      url: 'https://mcp.notion.com/mcp', official: true, homepage: 'https://notion.so',
      blurb: 'Search, read, and create Notion pages and databases. Needs Notion sign-in (OAuth).' },
    { id: 'linear', name: 'Linear', category: 'Productivity', authType: 'oauth', transport: 'http',
      url: 'https://mcp.linear.app/mcp', official: true, homepage: 'https://linear.app',
      blurb: 'Create, search, and update Linear issues and projects. Needs Linear sign-in (OAuth).' },
    { id: 'atlassian', name: 'Jira & Confluence', category: 'Productivity', authType: 'oauth', transport: 'http',
      url: '', official: true, homepage: 'https://atlassian.com',
      blurb: 'Atlassian Jira issues and Confluence pages. Needs Atlassian sign-in (OAuth).' },
    { id: 'github', name: 'GitHub', category: 'Developer Tools', authType: 'oauth', transport: 'http',
      url: 'https://api.githubcopilot.com/mcp', official: true, homepage: 'https://github.com',
      blurb: 'Issues, pull requests, code search, and Actions across your repos. Needs GitHub sign-in (OAuth).' },
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
      installable: isInstallable(e)
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

  // the browse payload: entries (optionally annotated with `installed` from the live connector configs),
  // grouped by category in stable order. `installedIds` is any iterable of already-configured connector ids.
  function browse(installedIds) {
    const have = new Set();
    if (installedIds && typeof installedIds.forEach === 'function') installedIds.forEach(x => have.add(String(x)));
    else if (Array.isArray(installedIds)) for (const x of installedIds) have.add(String(x));
    const entries = CATALOG.map(e => { const c = cloneEntry(e); c.installed = have.has(c.id); return c; });
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
