'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { buildCsv, inspectContent, buildFilename } = require('../src/portal/report');
const { getOrg } = require('../src/shared/catalog');
const { findAccount, verifyPassword } = require('../src/portal/accounts');
const { openDatabase, createRun, getRun, createCondition } = require('../src/db');

test('科目内容由组织、账期与对账码共同决定，并可通过内容核对', () => {
  const org = getOrg('ORG-BETA');
  const csv = buildCsv({ org, period: '2026-09', ref: 'rk-test-0001' });
  const result = inspectContent(csv, { org, period: '2026-09', ref: 'rk-test-0001' });
  assert.equal(result.ok, true);
  assert.equal(result.rowCount, 5);

  const wrongOrg = inspectContent(csv, { org: getOrg('ORG-ALPHA'), period: '2026-09', ref: 'rk-test-0001' });
  assert.equal(wrongOrg.ok, false);

  const wrongPeriod = inspectContent(csv, { org, period: '2026-08', ref: 'rk-test-0001' });
  assert.equal(wrongPeriod.ok, false);

  const wrongRef = inspectContent(csv, { org, period: '2026-09', ref: 'rk-test-0002' });
  assert.equal(wrongRef.ok, false);
});

test('同一组条件与对账码生成的正文完全相同（可校验重复生成）', () => {
  const org = getOrg('ORG-GAMMA');
  const fixedAt = '2026-10-01T00:00:00.000Z';
  const a = buildCsv({ org, period: '2026-10', ref: 'rk-fixed', generatedAt: fixedAt });
  const b = buildCsv({ org, period: '2026-10', ref: 'rk-fixed', generatedAt: fixedAt });
  assert.equal(a, b);
  assert.notEqual(a, buildCsv({ org, period: '2026-10', ref: 'rk-other', generatedAt: fixedAt }));
});

test('文件名包含组织与账期，便于下载后核对', () => {
  const filename = buildFilename({ org: getOrg('ORG-ALPHA'), period: '2026-07', ref: 'rk-abcdef123456' });
  assert.match(filename, /^settlement_org-alpha_2026-07_[A-Za-z0-9_-]+\.csv$/);
});

test('演示账号密码按 scrypt 正常校验，错误密码被拒绝', () => {
  const account = findAccount('demo@example.test');
  assert.ok(account);
  assert.equal(verifyPassword(account, 'local-demo-2026!'), true);
  assert.equal(verifyPassword(account, 'wrong-password'), false);
  assert.equal(findAccount('nobody@example.test'), null);
});

test('运行记录把条件锁进数据库，run_key 唯一且稳定', () => {
  const db = openDatabase(':memory:');
  const condition = createCondition(db, {
    org: 'ORG-BETA',
    period: '2026-08',
    reportType: 'billing-summary',
    label: '',
  });
  const run = createRun(db, {
    org: 'ORG-BETA',
    period: '2026-08',
    reportType: 'billing-summary',
    conditionId: condition.id,
    expireMode: 'during_run',
    closeAt: 'after_apply',
  });
  const stored = getRun(db, run.id);
  assert.equal(stored.org, 'ORG-BETA');
  assert.equal(stored.period, '2026-08');
  assert.equal(stored.run_key, run.run_key);
  assert.equal(stored.expire_mode, 'during_run');
  assert.equal(stored.close_at, 'after_apply');
  assert.match(stored.run_key, /^rk-[a-f0-9]+$/);
});
