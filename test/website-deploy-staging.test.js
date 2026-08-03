'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const A = require('./_assert.js');

const root = path.join(__dirname, '..');
const staged = path.join(root, 'website-deploy');
const run = spawnSync(process.execPath, ['scripts/stage-website-deploy.mjs'], { cwd: root, encoding: 'utf8' });
A.eq(run.status, 0, 'guarded website staging completes');
A.eq(fs.existsSync(path.join(staged, 'pricing.html')), false, 'held-back pricing page is absent from deploy artifact');
A.eq(fs.existsSync(path.join(staged, 'app', 'assets', 'sprites', '_assembly')), false, 'sprite assembly sources are absent from deploy artifact');
A.ok(fs.existsSync(path.join(staged, 'app', 'index.html')), 'staged artifact retains the embedded app');

const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'deploy-website.yml'), 'utf8');
A.ok(/run: npm run website:stage/.test(workflow), 'Pages workflow builds the guarded artifact');
A.ok(/path: website-deploy/.test(workflow), 'Pages workflow uploads only the guarded artifact');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
A.eq(pkg.scripts['website:stage'], 'node scripts/stage-website-deploy.mjs', 'staging has one package entry point');

const home = fs.readFileSync(path.join(root, 'website', 'index.html'), 'utf8');
const pricingTags = home.match(/<[^>]+data-pricing-link[^>]*>/g) || [];
A.ok(pricingTags.length > 0 && pricingTags.every(tag => /\shidden(?:\s|>)/.test(tag)), 'held-back pricing is hidden in raw HTML before JavaScript runs');
const site = fs.readFileSync(path.join(root, 'website', 'site.js'), 'utf8');
A.ok(/el\.hidden = !PRICING_LIVE/.test(site), 'the release flag explicitly reveals or hides every pricing fragment');
A.eq(/RELEASES_PAGE/.test(site), false, 'unused release-page alias is gone');

const privacy = fs.readFileSync(path.join(root, 'website', 'legal', 'privacy.html'), 'utf8');
A.ok(/Edge Read Aloud/.test(privacy) && !/Live Voice works with no network at all/.test(privacy), 'public voice disclosure names the network fallback without an absolute offline claim');
const connectors = fs.readFileSync(path.join(root, 'website', 'docs', 'connectors.html'), 'utf8');
const toolsets = fs.readFileSync(path.join(root, 'sidecar', 'capability', 'toolsets.js'), 'utf8');
const workbench = 'Run shell commands and verify code — the code-execution bench.';
A.ok(connectors.includes(workbench) && toolsets.includes(workbench), 'public and in-app workbench descriptions match actual granted tools');
const sidecar = fs.readFileSync(path.join(root, 'sidecar', 'index.js'), 'utf8');
A.eq(/function saveConnectorOauth\(/.test(sidecar), false, 'unused connector OAuth persistence wrapper is removed');

A.report('website-deploy-staging.test');
