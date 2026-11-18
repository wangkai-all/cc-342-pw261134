'use strict';

const { configureRuntimeEnv } = require('./runtime');
configureRuntimeEnv();

const express = require('express');
const path = require('node:path');
const { loadConfig } = require('./config');
const { openDatabase } = require('./db');
const { sessionMiddleware } = require('./portal/session');
const { ensurePortalRouter } = require('./portal/router');
const { ensureConsoleRouter } = require('./collector/router');
const { Collector } = require('./collector/collector');

function createApp({ config, db }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));
  app.use(express.json({ limit: '64kb' }));
  app.use(sessionMiddleware());

  const collector = new Collector({ db, config, logger: () => {} });
  config.portalBaseUrl = `http://${config.host}:${config.port}`;

  app.use(ensurePortalRouter(db));
  app.use(ensureConsoleRouter({ db, collector, config }));

  app.use((req, res) => {
    res.status(404).send('页面不存在。');
  });

  return { app, collector };
}

async function main() {
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  const { app, collector } = createApp({ config, db });

  const server = app.listen(config.port, config.host, () => {
    config.portalBaseUrl = `http://${config.host}:${config.port}`;
    console.log(`portal   ${config.portalBaseUrl}/portal`);
    console.log(`console  ${config.portalBaseUrl}/`);
    console.log(`data     ${path.resolve(config.dataDir)}`);
  });

  const shutdown = async (signal) => {
    console.log(`\n${signal} received, shutting down`);
    server.close();
    await collector.closeAll().catch(() => {});
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { createApp };
