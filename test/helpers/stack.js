'use strict';

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { configureRuntimeEnv } = require('../../src/runtime');

/**
 * 测试夹具：真实启动门户 + 采集台，使用独立的临时数据目录与全新浏览器 profile。
 */
async function startStack(overrides = {}) {
  configureRuntimeEnv();

  const dataDir = overrides.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'portal-e2e-'));
  const { loadConfig } = require('../../src/config');
  const { openDatabase } = require('../../src/db');
  const { createApp } = require('../../src/server');

  const config = loadConfig({
    root: path.resolve(__dirname, '../..'),
    dataDir,
    host: '127.0.0.1',
    port: 0,
    headless: true,
  });

  const db = openDatabase(config.dbPath);
  const { app, collector } = createApp({ config, db });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  config.portalBaseUrl = baseUrl;

  return {
    baseUrl,
    dataDir,
    config,
    db,
    collector,
    server,
    async close() {
      await collector.closeAll().catch(() => {});
      await new Promise((resolve) => server.close(resolve));
      db.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

async function api(baseUrl, pathname, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      accept: 'application/json',
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, headers: response.headers, text, json };
}

async function waitForRun(baseUrl, runId, predicate, { timeoutMs = 90000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const response = await api(baseUrl, `/api/runs/${runId}`);
    if (response.status === 200) {
      last = response.json;
      if (predicate(last)) return last;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`等待运行 ${runId} 超时，最后状态：${JSON.stringify(last && last.run)}`);
}

function isTerminal(status) {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

module.exports = { startStack, api, waitForRun, isTerminal };
