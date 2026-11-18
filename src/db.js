'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS conditions (
  id           TEXT PRIMARY KEY,
  org          TEXT NOT NULL,
  period       TEXT NOT NULL,
  report_type  TEXT NOT NULL,
  label        TEXT,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id                     TEXT PRIMARY KEY,
  condition_id           TEXT,
  org                    TEXT NOT NULL,
  period                 TEXT NOT NULL,
  report_type            TEXT NOT NULL,
  label                  TEXT,
  run_key                TEXT NOT NULL UNIQUE,
  expire_mode            TEXT NOT NULL DEFAULT 'none',
  expire_during_run      INTEGER NOT NULL DEFAULT 0,
  expire_after_generate  INTEGER NOT NULL DEFAULT 0,
  close_and_resume       INTEGER NOT NULL DEFAULT 0,
  close_at               TEXT,
  status                 TEXT NOT NULL DEFAULT 'queued',
  phase                  TEXT NOT NULL DEFAULT 'created',
  attempts               INTEGER NOT NULL DEFAULT 0,
  note                   TEXT,
  error                  TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  started_at             TEXT,
  finished_at            TEXT
);

CREATE TABLE IF NOT EXISTS run_events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id    TEXT NOT NULL,
  seq       INTEGER NOT NULL,
  phase     TEXT NOT NULL,
  type      TEXT NOT NULL,
  detail    TEXT NOT NULL,
  at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS run_events_run ON run_events(run_id, seq);

CREATE TABLE IF NOT EXISTS downloads (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL,
  filename     TEXT NOT NULL,
  path         TEXT NOT NULL,
  sha256       TEXT NOT NULL,
  size         INTEGER NOT NULL,
  org          TEXT NOT NULL,
  period       TEXT NOT NULL,
  report_type  TEXT NOT NULL,
  run_key      TEXT NOT NULL,
  verified     INTEGER NOT NULL DEFAULT 0,
  source       TEXT NOT NULL,
  received_at  TEXT NOT NULL,
  preview      TEXT
);

CREATE TABLE IF NOT EXISTS portal_generations (
  id                 TEXT PRIMARY KEY,
  run_key            TEXT NOT NULL,
  org                TEXT NOT NULL,
  period             TEXT NOT NULL,
  report_type        TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'ready',
  filename           TEXT NOT NULL,
  csv                TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  download_count     INTEGER NOT NULL DEFAULT 0,
  last_downloaded_at TEXT
);
CREATE INDEX IF NOT EXISTS portal_generations_ref ON portal_generations(run_key);
`;

function nowIso() {
  return new Date().toISOString();
}

function openDatabase(file) {
  const directory = path.dirname(path.resolve(file));
  fs.mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  return db;
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

function makeRunKey() {
  return `rk-${crypto.randomUUID().replace(/-/g, '')}`;
}

/* ---------- business conditions ---------- */

function createCondition(db, { org, period, reportType, label }) {
  const id = makeId('cond');
  db.prepare(
    `INSERT INTO conditions (id, org, period, report_type, label, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, org, period, reportType, label || null, nowIso());
  return getCondition(db, id);
}

function getCondition(db, id) {
  return db.prepare('SELECT * FROM conditions WHERE id = ?').get(id) || null;
}

function listConditions(db) {
  return db
    .prepare('SELECT * FROM conditions ORDER BY created_at DESC, id DESC')
    .all();
}

/* ---------- runs ---------- */

function createRun(db, {
  org,
  period,
  reportType,
  label,
  conditionId,
  expireMode = 'none',
  closeAt = null,
}) {
  const expireDuringRun = expireMode === 'during_run';
  const expireAfterGenerate = expireMode === 'after_generate';
  const closeAndResume = Boolean(closeAt);
  const id = makeId('run');
  const runKey = makeRunKey();
  const at = nowIso();
  db.prepare(
    `INSERT INTO runs
       (id, condition_id, org, period, report_type, label, run_key,
        expire_mode, expire_during_run, expire_after_generate,
        close_and_resume, close_at,
        status, phase, attempts, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 'created', 0, ?, ?)`,
  ).run(
    id,
    conditionId || null,
    org,
    period,
    reportType,
    label || null,
    runKey,
    expireMode,
    expireDuringRun ? 1 : 0,
    expireAfterGenerate ? 1 : 0,
    closeAndResume ? 1 : 0,
    closeAt,
    at,
    at,
  );
  return getRun(db, id);
}

function getRun(db, id) {
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(id);
  return run || null;
}

function listRuns(db) {
  return db.prepare('SELECT * FROM runs ORDER BY created_at DESC, id DESC').all();
}

function updateRun(db, id, fields) {
  const allowed = [
    'status',
    'phase',
    'attempts',
    'note',
    'error',
    'started_at',
    'finished_at',
  ];
  const assignments = [];
  const values = [];
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      assignments.push(`${key} = ?`);
      values.push(fields[key]);
    }
  }
  if (assignments.length === 0) return getRun(db, id);
  assignments.push('updated_at = ?');
  values.push(nowIso());
  values.push(id);
  db.prepare(`UPDATE runs SET ${assignments.join(', ')} WHERE id = ?`).run(...values);
  return getRun(db, id);
}

/* ---------- run events ---------- */

function appendEvent(db, runId, { phase, type, detail }) {
  const next = db
    .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM run_events WHERE run_id = ?')
    .get(runId).seq;
  const at = nowIso();
  db.prepare(
    `INSERT INTO run_events (run_id, seq, phase, type, detail, at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(runId, next, phase, type, JSON.stringify(detail === undefined ? {} : detail), at);
  return next;
}

function countEvents(db, runId, type) {
  return db
    .prepare('SELECT COUNT(*) AS n FROM run_events WHERE run_id = ? AND type = ?')
    .get(runId, type).n;
}

function listEvents(db, runId) {
  return db
    .prepare('SELECT * FROM run_events WHERE run_id = ? ORDER BY seq ASC')
    .all(runId)
    .map((event) => ({ ...event, detail: safeJson(event.detail) }));
}

/* ---------- downloads ---------- */

function createDownload(db, data) {
  const id = makeId('dl');
  db.prepare(
    `INSERT INTO downloads
       (id, run_id, filename, path, sha256, size, org, period, report_type,
        run_key, verified, source, received_at, preview)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    data.runId,
    data.filename,
    data.path,
    data.sha256,
    data.size,
    data.org,
    data.period,
    data.reportType,
    data.runKey,
    data.verified ? 1 : 0,
    data.source,
    nowIso(),
    data.preview || null,
  );
  return db.prepare('SELECT * FROM downloads WHERE id = ?').get(id);
}

function listDownloads(db, runId) {
  return db
    .prepare('SELECT * FROM downloads WHERE run_id = ? ORDER BY received_at ASC, id ASC')
    .all(runId);
}

function getDownload(db, id) {
  return db.prepare('SELECT * FROM downloads WHERE id = ?').get(id) || null;
}

/* ---------- portal generation records (written by the portal) ---------- */

function getGenerationByRunKey(db, runKey) {
  return db.prepare('SELECT * FROM portal_generations WHERE run_key = ?').get(runKey) || null;
}

function listGenerationsByRunKey(db, runKey) {
  return db
    .prepare('SELECT * FROM portal_generations WHERE run_key = ? ORDER BY created_at ASC')
    .all(runKey);
}

function getGeneration(db, id) {
  return db.prepare('SELECT * FROM portal_generations WHERE id = ?').get(id) || null;
}

function createGeneration(db, generation) {
  db.prepare(
    `INSERT INTO portal_generations
       (id, run_key, org, period, report_type, status, filename, csv, created_at)
     VALUES (?, ?, ?, ?, ?, 'ready', ?, ?, ?)`,
  ).run(
    generation.id,
    generation.runKey,
    generation.org,
    generation.period,
    generation.reportType,
    generation.filename,
    generation.csv,
    nowIso(),
  );
  return getGenerationByRunKey(db, generation.runKey);
}

function listGenerations(db, { org, period }) {
  return db
    .prepare(
      `SELECT * FROM portal_generations
       WHERE org = ? AND period = ?
       ORDER BY created_at DESC, id DESC`,
    )
    .all(org, period);
}

function markGenerationDownloaded(db, id) {
  db.prepare(
    `UPDATE portal_generations
     SET download_count = download_count + 1, last_downloaded_at = ?
     WHERE id = ?`,
  ).run(nowIso(), id);
}

function countGenerationsByRunKey(db, runKey) {
  return db.prepare('SELECT COUNT(*) AS n FROM portal_generations WHERE run_key = ?').get(runKey).n;
}

function safeJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

module.exports = {
  openDatabase,
  makeId,
  makeRunKey,
  nowIso,
  createCondition,
  getCondition,
  listConditions,
  createRun,
  getRun,
  listRuns,
  updateRun,
  appendEvent,
  countEvents,
  listEvents,
  createDownload,
  listDownloads,
  getDownload,
  getGenerationByRunKey,
  listGenerationsByRunKey,
  getGeneration,
  createGeneration,
  listGenerations,
  markGenerationDownloaded,
  countGenerationsByRunKey,
};
