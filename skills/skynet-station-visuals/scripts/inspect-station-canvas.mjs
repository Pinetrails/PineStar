#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

function parseArgs(argv) {
  const args = {
    url: 'http://127.0.0.1:8787',
    out: 'artifacts/station-canvas',
    selector: 'canvas#stage',
    mobile: false,
    wait: 1000,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === '--url') args.url = argv[++i];
    else if (value === '--out') args.out = argv[++i];
    else if (value === '--selector') args.selector = argv[++i];
    else if (value === '--mobile') args.mobile = true;
    else if (value === '--wait') args.wait = Number(argv[++i]);
    else if (value === '-h' || value === '--help') {
      console.log('Usage: inspect-station-canvas.mjs [--url URL] [--out DIR] [--selector CSS] [--mobile] [--wait MS]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }

  return args;
}

async function loadPlaywright() {
  try {
    return await import('@playwright/test');
  } catch (_) {
    try {
      const mod = await import('playwright');
      return { chromium: mod.chromium, devices: mod.devices || {} };
    } catch (error) {
      throw new Error('Playwright is required. Install @playwright/test or run from an environment that provides Playwright.');
    }
  }
}

async function sampleCanvas(page, selector) {
  return page.evaluate((sel) => {
    const canvases = Array.from(document.querySelectorAll(sel));
    const canvas = canvases.find((c) => {
      const r = c.getBoundingClientRect();
      return r.width >= 32 && r.height >= 32;
    }) || Array.from(document.querySelectorAll('canvas')).find((c) => {
      const r = c.getBoundingClientRect();
      return r.width >= 32 && r.height >= 32;
    });

    if (!canvas) {
      return { ok: false, reason: 'canvas-not-visible', rect: null, drawingBuffer: null };
    }

    const rect = canvas.getBoundingClientRect();
    const drawingBuffer = { width: canvas.width, height: canvas.height };
    if (canvas.width < 32 || canvas.height < 32) {
      return { ok: false, reason: 'drawing-buffer-too-small', rect, drawingBuffer };
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return { ok: false, reason: 'not-2d-canvas', rect, drawingBuffer };
    }

    let data;
    try {
      data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    } catch (error) {
      return { ok: false, reason: 'canvas-read-failed', rect, drawingBuffer, error: error.message };
    }

    let min = 255;
    let max = 0;
    let alphaPixels = 0;
    const colors = new Set();
    const pixels = canvas.width * canvas.height;
    const stride = Math.max(1, Math.floor(pixels / 4096));

    for (let pixel = 0; pixel < pixels; pixel += stride) {
      const offset = pixel * 4;
      const r = data[offset];
      const g = data[offset + 1];
      const b = data[offset + 2];
      const a = data[offset + 3];
      min = Math.min(min, r, g, b);
      max = Math.max(max, r, g, b);
      if (a > 0) alphaPixels += 1;
      colors.add(`${r >> 4},${g >> 4},${b >> 4},${a >> 6}`);
    }

    const variance = max - min;
    const ok = alphaPixels > 256 && (variance > 8 || colors.size > 3);
    return {
      ok,
      reason: ok ? 'nonblank' : 'low-variance',
      rect,
      drawingBuffer,
      alphaPixels,
      variance,
      colorBuckets: colors.size,
      href: location.href,
    };
  }, selector);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await mkdir(args.out, { recursive: true });
  const { chromium, devices } = await loadPlaywright();

  const browser = await chromium.launch();
  const context = await browser.newContext(args.mobile
    ? { ...(devices && devices['iPhone 13'] ? devices['iPhone 13'] : { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }) }
    : { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];

  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto(args.url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(args.wait);

  const result = await sampleCanvas(page, args.selector);
  const screenshotPath = path.join(args.out, args.mobile ? 'mobile.png' : 'desktop.png');
  await page.screenshot({ path: screenshotPath, fullPage: true });

  const report = {
    url: args.url,
    selector: args.selector,
    mode: args.mobile ? 'mobile' : 'desktop',
    screenshotPath,
    result,
    consoleErrors,
    pageErrors,
  };

  await writeFile(path.join(args.out, args.mobile ? 'mobile.json' : 'desktop.json'), `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();

  console.log(JSON.stringify(report, null, 2));

  if (!result.ok || consoleErrors.length > 0 || pageErrors.length > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
