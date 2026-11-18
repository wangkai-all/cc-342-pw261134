'use strict';

const crypto = require('node:crypto');

/**
 * 虚构结算报表。内容完全由业务条件（组织 + 账期 + 对账码）决定，
 * 下载后可以逐字段核对，从而判断“拿到的文件是不是这次条件生成的”。
 */
const REPORT_TYPE = 'billing-summary';

function buildCsv({ org, period, ref, generatedAt }) {
  const stamp = generatedAt || new Date().toISOString();
  const lines = [
    '组织编码,组织名称,账期,报表类型,对账码,生成时间,序号,业务金额',
  ];
  for (let index = 1; index <= 5; index += 1) {
    const digest = crypto
      .createHash('sha256')
      .update(`${org.code}|${period}|${ref}|${index}`)
      .digest();
    const amount = (digest.readUInt32BE(0) % 900000 + 100000) / 100;
    lines.push(
      [
        org.code,
        org.name,
        period,
        REPORT_TYPE,
        ref,
        stamp,
        index,
        amount.toFixed(2),
      ].join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}

function buildFilename({ org, period, ref }) {
  const short = String(ref).replace(/[^A-Za-z0-9_-]/g, '').slice(-8) || 'report';
  return `settlement_${org.code.toLowerCase()}_${period}_${short}.csv`;
}

function parseCsv(text) {
  const normalized = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const lines = normalized.split('\n').filter((line) => line.length > 0);
  if (lines.length === 0) return { header: [], rows: [] };
  const header = lines[0].split(',');
  const rows = lines.slice(1).map((line) => {
    const cells = line.split(',');
    const row = {};
    header.forEach((key, index) => {
      row[key] = cells[index];
    });
    return row;
  });
  return { header, rows };
}

function inspectContent(text, { org, period, ref }) {
  const { header, rows } = parseCsv(text);
  const required = ['组织编码', '账期', '报表类型', '对账码'];
  const missing = required.filter((column) => !header.includes(column));
  if (missing.length > 0) {
    return { ok: false, reason: `缺少列：${missing.join(',')}`, header, rowCount: rows.length };
  }
  if (rows.length === 0) {
    return { ok: false, reason: '文件没有数据行', header, rowCount: 0 };
  }
  const mismatched = rows.filter(
    (row) =>
      row['组织编码'] !== org.code ||
      row['账期'] !== period ||
      row['报表类型'] !== REPORT_TYPE ||
      row['对账码'] !== ref,
  );
  if (mismatched.length > 0) {
    return {
      ok: false,
      reason: `有 ${mismatched.length} 行与预期条件不一致`,
      header,
      rowCount: rows.length,
    };
  }
  return { ok: true, header, rowCount: rows.length };
}

module.exports = { REPORT_TYPE, buildCsv, buildFilename, parseCsv, inspectContent };
