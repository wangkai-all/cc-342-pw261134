'use strict';

const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const path = require('node:path');

const { configureRuntimeEnv } = require('../src/runtime');
configureRuntimeEnv();

const { startStack, waitForRun, isTerminal } = require('./helpers/stack');
const { chromium } = require('playwright');

const stackPromise = startStack();
let browserPromise = null;

function browser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: true, args: ['--no-sandbox'] });
  }
  return browserPromise;
}

after(async () => {
  const stack = await stackPromise;
  if (browserPromise) {
    const instance = await browserPromise;
    await instance.close().catch(() => {});
  }
  await stack.close();
});

async function openConsole() {
  const stack = await stackPromise;
  const instance = await browser();
  const page = await instance.newPage();
  page.on('pageerror', (error) => {
    throw error;
  });
  await page.goto(`${stack.baseUrl}/`);
  return page;
}

async function createRunThroughUi(page, { org, period, expireMode = 'none', closeAt = '' }) {
  await page.selectOption('#run-org', org);
  await page.selectOption('#run-period', period);
  await page.selectOption('#run-expire', expireMode);
  if (closeAt) await page.selectOption('#run-close', closeAt);
  await Promise.all([
    page.waitForURL(/\/\?run=/, { timeout: 15000 }),
    page.click('#create-run'),
  ]);
  const url = new URL(page.url());
  return url.searchParams.get('run');
}

test('在采集台网页上选择不同组织发起采集，并能看到下载与条件一致', async () => {
  const stack = await stackPromise;
  const page = await openConsole();

  const firstId = await createRunThroughUi(page, { org: 'ORG-ALPHA', period: '2026-07' });
  const first = await waitForRun(stack.baseUrl, firstId, (data) => isTerminal(data.run.status));
  assert.equal(first.run.status, 'succeeded', first.run.error || '');

  const secondId = await createRunThroughUi(page, { org: 'ORG-GAMMA', period: '2026-09' });
  const second = await waitForRun(stack.baseUrl, secondId, (data) => isTerminal(data.run.status));
  assert.equal(second.run.status, 'succeeded', second.run.error || '');

  assert.equal(first.run.org, 'ORG-ALPHA');
  assert.equal(second.run.org, 'ORG-GAMMA');
  assert.equal(second.downloads[0].org, 'ORG-GAMMA');
  assert.equal(second.downloads[0].period, '2026-09');

  // 页面刷新后仍能看到运行详情与校验结果。
  await page.goto(`${stack.baseUrl}/runs/${secondId}`);
  const text = await page.textContent('#run-conditions');
  assert.match(text, /ORG-GAMMA/);
  assert.match(text, /2026-09/);
  const downloads = await page.textContent('#run-downloads');
  assert.match(downloads, /settlement_org-gamma_2026-09_/);
  assert.match(downloads, /与条件一致/);

  await page.close();
});

test('页面被续期替换后，核对门户当前会话确实已过期', async () => {
  const stack = await stackPromise;
  const instance = await browser();
  const page = await instance.newPage();
  await page.goto(`${stack.baseUrl}/portal/login?return_to=%2Fportal`);
  await page.fill('#username', 'demo@example.test');
  await page.fill('#password', 'local-demo-2026!');
  await Promise.all([page.waitForURL(/\/portal/), page.click('#login-button')]);
  assert.match(page.url(), /\/portal/);

  // 使用门户自己的“模拟会话到期”按钮，真实撤销当前授予。
  await Promise.all([page.waitForNavigation(), page.click('#expire-now')]);
  const session = await (await fetch(`${stack.baseUrl}/portal/api/session`, {
    headers: { cookie: (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join('; ') },
  })).json();
  assert.equal(session.sessionState, 'expired');

  await page.goto(`${stack.baseUrl}/portal/report?org=ORG-GAMMA&period=2026-09`);
  const html = await page.content();
  assert.match(html, /data-page="renewal"/);
  assert.match(html, /续期并返回/);
  await page.close();
});

test('网页发起“操作途中到期”的采集，并可关闭浏览器后从采集台恢复', async () => {
  const stack = await stackPromise;
  const page = await openConsole();
  const runId = await createRunThroughUi(page, {
    org: 'ORG-BETA',
    period: '2026-08',
    expireMode: 'during_run',
  });
  await page.close();

  const result = await waitForRun(stack.baseUrl, runId, (data) => isTerminal(data.run.status), {
    timeoutMs: 120000,
  });
  assert.equal(result.run.status, 'succeeded', result.run.error || '');
  const types = result.events.map((event) => event.type);
  assert.ok(types.includes('session_renewed'));
  assert.equal(result.downloads[0].org, 'ORG-BETA');
  assert.equal(result.downloads[0].period, '2026-08');

  // 采集台页面也能看到“会话续期”这一步。
  const detail = await openConsole();
  await detail.goto(`${stack.baseUrl}/runs/${runId}`);
  const events = await detail.textContent('#run-events');
  assert.match(events, /session_renewed/);
  await detail.close();
});
