'use strict';

const assert = require('node:assert/strict');
const { test, after } = require('node:test');

const { startStack, api, waitForRun, isTerminal } = require('./helpers/stack');

// 真实浏览器端到端：启动门户 + 采集台，Chromium 实际点击页面、接收下载。
const stackPromise = startStack();
after(async () => {
  const stack = await stackPromise;
  const t0 = Date.now();
  await stack.close();
  console.error(`[teardown] closed in ${Date.now() - t0}ms`);
});

async function runScenario(body, { timeoutMs = 120000 } = {}) {
  const stack = await stackPromise;
  const created = await api(stack.baseUrl, '/api/runs', { method: 'POST', body });
  assert.equal(created.status, 202, created.text);
  const run = created.json.run;
  const result = await waitForRun(stack.baseUrl, run.id, (data) => isTerminal(data.run.status), {
    timeoutMs,
  });
  return result;
}

function readDownloadText(stack, record) {
  const fs = require('node:fs');
  return fs.readFileSync(record.path, 'utf8');
}

test('按业务条件采集：下载内容与组织、账期一致', async () => {
  const result = await runScenario({ org: 'ORG-BETA', period: '2026-09' });
  assert.equal(result.run.status, 'succeeded', result.run.error || '');
  assert.equal(result.downloads.length, 1);
  const record = result.downloads[0];
  assert.equal(record.org, 'ORG-BETA');
  assert.equal(record.period, '2026-09');
  assert.equal(record.verified, 1);
  assert.match(record.filename, /^settlement_org-beta_2026-09_/);

  const stack = await stackPromise;
  const text = readDownloadText(stack, record);
  assert.match(text, /ORG-BETA,远山制造,2026-09,billing-summary,/);
  assert.doesNotMatch(text, /ORG-ALPHA/);
});

test('可选不同组织：连续两次采集不会沿用上一个组织', async () => {
  const first = await runScenario({ org: 'ORG-GAMMA', period: '2026-10' });
  const second = await runScenario({ org: 'ORG-ALPHA', period: '2026-08' });
  assert.equal(first.run.status, 'succeeded', first.run.error || '');
  assert.equal(second.run.status, 'succeeded', second.run.error || '');

  assert.equal(first.downloads[0].org, 'ORG-GAMMA');
  assert.equal(second.downloads[0].org, 'ORG-ALPHA');

  const stack = await stackPromise;
  assert.match(readDownloadText(stack, first.downloads[0]), /ORG-GAMMA,星港物流,2026-10/);
  assert.match(readDownloadText(stack, second.downloads[0]), /ORG-ALPHA,晨曦零售,2026-08/);

  const applied = second.events.filter((event) => event.type === 'conditions_applied');
  assert.ok(applied.length >= 1);
  assert.equal(applied.at(-1).detail.frameOrg, 'ORG-ALPHA');
  assert.equal(applied.at(-1).detail.framePeriod, '2026-08');
});

test('操作途中会话到期：续期后重新选择组织与账期，再生成', async () => {
  const result = await runScenario({ org: 'ORG-BETA', period: '2026-08', expire_mode: 'during_run' });
  assert.equal(result.run.status, 'succeeded', result.run.error || '');
  const types = result.events.map((event) => event.type);
  assert.ok(types.includes('expiry_triggered'));
  assert.ok(types.includes('session_renewed'));
  assert.ok(types.includes('conditions_reapplied_after_renewal'));

  const reapplied = result.events.find((event) => event.type === 'conditions_reapplied_after_renewal');
  assert.equal(reapplied.detail.org, 'ORG-BETA');
  assert.equal(reapplied.detail.period, '2026-08');

  // 续期后页面会回到默认组织，但采集必须仍以库里的条件为准。
  assert.equal(result.downloads[0].org, 'ORG-BETA');
  assert.equal(result.downloads[0].period, '2026-08');
  const stack = await stackPromise;
  assert.match(readDownloadText(stack, result.downloads[0]), /ORG-BETA,远山制造,2026-08/);
});

test('生成已生效但返回前到期：先核实既有生成记录，不重复生成', async () => {
  const result = await runScenario({ org: 'ORG-GAMMA', period: '2026-07', expire_mode: 'after_generate' });
  assert.equal(result.run.status, 'succeeded', result.run.error || '');

  const types = result.events.map((event) => event.type);
  assert.ok(types.includes('generation_exists'));
  assert.ok(types.includes('conditions_restored_for_collection'));
  assert.equal(result.downloads[0].source, 'recovered');

  // 幂等键只对应一条门户生成记录。
  const stack = await stackPromise;
  assert.equal(stack.collector.db.prepare('SELECT COUNT(*) AS n FROM portal_generations WHERE run_key = ?').get(result.run.run_key).n, 1);
  assert.equal(result.downloads[0].org, 'ORG-GAMMA');
  assert.equal(result.downloads[0].period, '2026-07');
});

test('应用条件前关闭浏览器：重新启动后仍按库中条件采集', async () => {
  const result = await runScenario({ org: 'ORG-ALPHA', period: '2026-09', close_at: 'before_apply' });
  assert.equal(result.run.status, 'succeeded', result.run.error || '');
  const types = result.events.map((event) => event.type);
  assert.ok(types.includes('browser_closed_by_plan'));
  assert.ok(types.includes('browser_reopened'));
  assert.equal(result.downloads[0].org, 'ORG-ALPHA');
  assert.equal(result.downloads[0].period, '2026-09');
});

test('应用条件后关闭浏览器：旧 iframe 句柄作废，恢复时重新解析页面', async () => {
  const result = await runScenario({ org: 'ORG-GAMMA', period: '2026-08', close_at: 'after_apply' });
  assert.equal(result.run.status, 'succeeded', result.run.error || '');
  const types = result.events.map((event) => event.type);
  assert.ok(types.includes('browser_closed_by_plan'));
  assert.ok(types.includes('conditions_reapplied'));

  const applied = result.events.filter((event) => event.type === 'conditions_applied');
  const reapplied = result.events.find((event) => event.type === 'conditions_reapplied');
  assert.notEqual(applied.at(-1).detail.frameRender, reapplied.detail.frameRender);
  assert.equal(result.downloads[0].org, 'ORG-GAMMA');
});

test('清除浏览器后可从库中条件恢复，并从既有生成记录取回文件', async () => {
  const stack = await stackPromise;
  const created = await api(stack.baseUrl, '/api/runs', {
    method: 'POST',
    body: { org: 'ORG-BETA', period: '2026-07' },
  });
  const first = await waitForRun(stack.baseUrl, created.json.run.id, (data) => isTerminal(data.run.status));

  // 关闭所有浏览器，模拟“页面和句柄全没了”（采集台本身仍在运行）。
  await stack.collector.closeBrowsers();

  const resumed = await api(stack.baseUrl, `/api/runs/${first.run.id}/resume`, { method: 'POST' });
  assert.equal(resumed.status, 202);
  const second = await waitForRun(stack.baseUrl, first.run.id, (data) => isTerminal(data.run.status));

  assert.equal(second.run.status, 'succeeded', second.run.error || '');
  assert.equal(second.run.attempts > first.run.attempts, true);
  // 同一幂等键：第二次没有新建门户生成记录，只重新取回同一份文件。
  assert.equal(stack.collector.db.prepare('SELECT COUNT(*) AS n FROM portal_generations WHERE run_key = ?').get(first.run.run_key).n, 1);
  const recovered = second.events.find((event) => event.type === 'reused_existing_generation');
  assert.ok(recovered);
});

test('采集台页面可发起采集并能看到运行详情', async () => {
  const stack = await stackPromise;
  const form = new URLSearchParams({
    org: 'ORG-ALPHA',
    period: '2026-07',
    label: '表单发起',
    expire_mode: 'none',
    close_at: '',
  });
  const response = await fetch(`${stack.baseUrl}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
    redirect: 'manual',
  });
  assert.equal(response.status, 302);
  const runs = await api(stack.baseUrl, '/api/runs');
  const run = runs.json.runs.find((item) => item.label === '表单发起');
  assert.ok(run);
  const detail = await fetch(`${stack.baseUrl}/runs/${run.id}`);
  assert.equal(detail.status, 200);
  const html = await detail.text();
  assert.match(html, /业务条件（来自数据库）/);
  assert.match(html, /ORG-ALPHA/);
});

test('报表页没有对应下载链接时，按生成记录地址直接取回文件', async () => {
  const stack = await stackPromise;
  const fs = require('node:fs');
  const path = require('node:path');
  const { BrowserHost } = require('../src/collector/browser');
  const { PortalDriver } = require('../src/collector/driver');

  // 先通过采集台在 2026-09 生成一份报表。
  const created = await runScenario({ org: 'ORG-BETA', period: '2026-09' });
  assert.equal(created.run.status, 'succeeded', created.run.error || '');
  const ref = created.run.run_key;

  const host = new BrowserHost({
    profileDir: path.join(stack.dataDir, 'profiles', 'fallback-probe'),
    headless: true,
  });
  const driver = new PortalDriver({
    host,
    baseUrl: stack.baseUrl,
    credentials: { username: 'demo@example.test', password: 'local-demo-2026!' },
  });
  try {
    // 把页面停在另一个账期：当前页面的生成记录里没有这一条的下载链接。
    await driver.ensureAuthenticated({ org: 'ORG-BETA' });
    await driver.applyConditions({ org: 'ORG-BETA', period: '2026-08' });

    const result = await driver.downloadExisting({ ref });
    assert.equal(result.type, 'download', JSON.stringify(result));
    const saved = await driver.saveDownload(result.download, path.join(stack.dataDir, 'fallback.csv'));
    assert.match(saved.filename, /^settlement_org-beta_2026-09_/);
    assert.match(fs.readFileSync(saved.path, 'utf8'), /ORG-BETA,远山制造,2026-09/);
  } finally {
    await driver.closePage();
    await host.close();
  }
});
