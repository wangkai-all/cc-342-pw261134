'use strict';

const path = require('node:path');

function intEnv(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function loadConfig(overrides = {}) {
  const root = overrides.root || path.resolve(__dirname, '..');
  const config = {
    root,
    host: process.env.HOST || '127.0.0.1',
    port: intEnv(process.env.PORT, 4310),
    dataDir: path.resolve(root, process.env.DATA_DIR || 'data'),
    headless: process.env.COLLECTOR_HEADED !== '1',
    navigationTimeoutMs: intEnv(process.env.NAVIGATION_TIMEOUT_MS, 20000),
    portalBaseUrl: '',
    portal: {
      username: process.env.PORTAL_USERNAME || 'demo@example.test',
      password: process.env.PORTAL_PASSWORD || 'local-demo-2026!',
    },
    ...overrides,
  };
  config.dbPath = overrides.dbPath || path.join(config.dataDir, 'collector.sqlite');
  config.profilesDir = path.join(config.dataDir, 'profiles');
  config.downloadsDir = path.join(config.dataDir, 'downloads');
  return config;
}

module.exports = { loadConfig };
