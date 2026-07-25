/* sidecar/servicekeys-catalog.js — the PLATFORM directory behind the KEYS tab.

   WHY THIS EXISTS, and why it is NOT more MCP catalog rows: most platforms people want to connect ship no
   remote MCP server at all. Probed 2026-07-24 — printify, printful, etsy, woocommerce, shopify(catalog/dev)
   all 404 or do not resolve, and the only Printify MCP that exists is a LOCAL `npx` server StarNet
   deliberately refuses to spawn. Seeding them as connectors would be a lie the moment a user clicked.

   What DOES work for every one of them is the generic path: paste the platform's API key in KEYS, place a
   dish, and the agent calls the REST API with web_request. This directory just makes that path findable —
   it turns "paste a key for… something?" into "pick your platform". Each row is pure data:

     id       — stable slug
     name     — what the Commander picks; servicekeys.deriveEnvVar(name) MUST equal envVar (locked by test)
     envVar   — the name the agent references as ${ENVVAR} in a header
     docsUrl  — the API reference. This rides into the system prompt, so the agent can look up endpoints
                itself instead of guessing — the single highest-value field here.
     apiBase  — the documented base URL, shown so a Commander can sanity-check what the agent will call
     authHint — the header shape, ONLY where verified. Omitted rather than guessed: a wrong hint would send
                every agent down a broken path, which is worse than no hint (the agent reads docsUrl).
     note     — anything that would otherwise surprise the user (e.g. OAuth, per-store hosts)

   Adding a platform is a DATA ROW here, never new code — same extension model as mcp/catalog.js. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; (root.SK.servicekeysCatalog = api); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CATEGORY_ORDER = ['Commerce & Print-on-Demand', 'Payments', 'Email & Messaging', 'Data & Content', 'Developer Tools', 'AI & Media'];

  const PLATFORMS = [
    // ── Commerce & Print-on-Demand — the gap that started this: no MCP server exists for ANY of these ──
    { id: 'printify', name: 'Printify', category: 'Commerce & Print-on-Demand', envVar: 'PRINTIFY_API_KEY',
      docsUrl: 'https://developers.printify.com/', apiBase: 'https://api.printify.com/v1',
      authHint: 'Authorization: Bearer ${PRINTIFY_API_KEY}',
      blurb: 'Print-on-demand: shops, blueprints, products, orders, publishing.',
      note: 'Create a personal access token under Printify → Settings → API.' },

    { id: 'printful', name: 'Printful', category: 'Commerce & Print-on-Demand', envVar: 'PRINTFUL_API_KEY',
      docsUrl: 'https://developers.printful.com/', apiBase: 'https://api.printful.com',
      authHint: 'Authorization: Bearer ${PRINTFUL_API_KEY}',
      blurb: 'Print-on-demand fulfilment: catalog, orders, mockups, shipping rates.' },

    { id: 'shopify', name: 'Shopify', category: 'Commerce & Print-on-Demand', envVar: 'SHOPIFY_API_KEY',
      docsUrl: 'https://shopify.dev/docs/api/admin-rest', apiBase: 'https://{your-store}.myshopify.com/admin/api',
      authHint: 'X-Shopify-Access-Token: ${SHOPIFY_API_KEY}',
      blurb: 'Storefront admin: products, orders, customers, inventory.',
      note: 'The host is YOUR store (your-store.myshopify.com), so tell the agent which store it is working on.' },

    { id: 'etsy', name: 'Etsy', category: 'Commerce & Print-on-Demand', envVar: 'ETSY_API_KEY',
      docsUrl: 'https://developers.etsy.com/documentation/', apiBase: 'https://openapi.etsy.com/v3',
      blurb: 'Marketplace listings, shops, and orders.',
      note: 'Etsy v3 needs an OAuth 2 access token for most endpoints, not just the app keystring — read the docs link before expecting writes to work.' },

    // ── Payments ──
    { id: 'stripe', name: 'Stripe', category: 'Payments', envVar: 'STRIPE_API_KEY',
      docsUrl: 'https://docs.stripe.com/api', apiBase: 'https://api.stripe.com/v1',
      authHint: 'Authorization: Bearer ${STRIPE_API_KEY}',
      blurb: 'Payments, customers, invoices, subscriptions.',
      note: 'Prefer a restricted key. Stripe also has a one-click MCP connector in CATALOG — use that if you want tools instead of raw REST.' },

    // ── Email & Messaging ──
    { id: 'resend', name: 'Resend', category: 'Email & Messaging', envVar: 'RESEND_API_KEY',
      docsUrl: 'https://resend.com/docs/api-reference/introduction', apiBase: 'https://api.resend.com',
      authHint: 'Authorization: Bearer ${RESEND_API_KEY}',
      blurb: 'Transactional email sending, domains, audiences.' },

    { id: 'sendgrid', name: 'SendGrid', category: 'Email & Messaging', envVar: 'SENDGRID_API_KEY',
      docsUrl: 'https://www.twilio.com/docs/sendgrid/api-reference', apiBase: 'https://api.sendgrid.com/v3',
      authHint: 'Authorization: Bearer ${SENDGRID_API_KEY}',
      blurb: 'Email delivery, templates, and stats.' },

    // ── Data & Content ──
    { id: 'airtable', name: 'Airtable', category: 'Data & Content', envVar: 'AIRTABLE_API_KEY',
      docsUrl: 'https://airtable.com/developers/web/api/introduction', apiBase: 'https://api.airtable.com/v0',
      authHint: 'Authorization: Bearer ${AIRTABLE_API_KEY}',
      blurb: 'Bases, tables, and records as a lightweight database.' },

    { id: 'notion', name: 'Notion', category: 'Data & Content', envVar: 'NOTION_API_KEY',
      docsUrl: 'https://developers.notion.com/reference/intro', apiBase: 'https://api.notion.com/v1',
      authHint: 'Authorization: Bearer ${NOTION_API_KEY}',
      blurb: 'Pages, databases, and blocks.',
      note: 'Notion also has a one-click OAuth connector in CATALOG — that is usually the easier route.' },

    // ── Developer Tools ──
    { id: 'github', name: 'GitHub', category: 'Developer Tools', envVar: 'GITHUB_API_KEY',
      docsUrl: 'https://docs.github.com/rest', apiBase: 'https://api.github.com',
      authHint: 'Authorization: Bearer ${GITHUB_API_KEY}',
      blurb: 'Repos, issues, pull requests, actions.',
      note: 'GitHub also has a one-click MCP connector in CATALOG.' }

    // NOTE — model providers (OpenRouter, Anthropic, OpenAI…) are deliberately ABSENT. Their env names are
    // reserved: servicekeys.upsert refuses them so a pasted key can never silently become billing
    // credentials. Listing one here would put a row in the picker that always fails on save.
  ];

  function categories() {
    const seen = [];
    for (const p of PLATFORMS) if (seen.indexOf(p.category) < 0) seen.push(p.category);
    return seen.slice().sort((a, b) => {
      const ia = CATEGORY_ORDER.indexOf(a), ib = CATEGORY_ORDER.indexOf(b);
      if (ia < 0 && ib < 0) return a.localeCompare(b);
      if (ia < 0) return 1;
      if (ib < 0) return -1;
      return ia - ib;
    });
  }

  // grouped view for the picker; `installed` marks platforms the Commander already has a key for.
  function grouped(existingEnvVars) {
    const have = new Set(Array.isArray(existingEnvVars) ? existingEnvVars : []);
    return categories().map(c => ({
      category: c,
      platforms: PLATFORMS.filter(p => p.category === c)
        .slice().sort((a, b) => a.name.localeCompare(b.name))
        .map(p => Object.assign({}, p, { installed: have.has(p.envVar) }))
    }));
  }

  function byId(id) { return PLATFORMS.find(p => p.id === String(id || '')) || null; }

  return { PLATFORMS, CATEGORY_ORDER, categories, grouped, byId };
});
