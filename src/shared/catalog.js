'use strict';

/**
 * 本地虚构业务目录。
 * 门户与采集台共用同一份组织/账期定义，避免采集台靠猜测拼参数。
 */
const ORGS = Object.freeze([
  { code: 'ORG-ALPHA', name: '晨曦零售', short: '晨曦' },
  { code: 'ORG-BETA', name: '远山制造', short: '远山' },
  { code: 'ORG-GAMMA', name: '星港物流', short: '星港' },
]);

const PERIODS = Object.freeze(['2026-10', '2026-09', '2026-08', '2026-07']);
const REPORT_TYPE = 'billing-summary';

function getOrg(code) {
  return ORGS.find((org) => org.code === code) || null;
}

function getPeriods() {
  return [...PERIODS];
}

function defaultOrg() {
  return ORGS[0];
}

function defaultPeriod() {
  return PERIODS[0];
}

function isPeriod(value) {
  return PERIODS.includes(value);
}

function orgAllowedForUser(user, orgCode) {
  return Boolean(user && Array.isArray(user.orgs) && user.orgs.includes(orgCode));
}

module.exports = {
  ORGS,
  PERIODS,
  REPORT_TYPE,
  getOrg,
  getPeriods,
  defaultOrg,
  defaultPeriod,
  isPeriod,
  orgAllowedForUser,
};
