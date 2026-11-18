'use strict';

const express = require('express');
const crypto = require('node:crypto');
const { ACCOUNTS, findAccount, verifyPassword, publicUser } = require('./accounts');
const { rotateSession, clearUser, grantValid } = require('./session');
const { escapeHtml, layout, portalHeader } = require('./html');
const { ORGS, getOrg, getPeriods, defaultOrg, defaultPeriod, isPeriod, orgAllowedForUser } = require('../shared/catalog');
const { REPORT_TYPE, buildCsv, buildFilename } = require('./report');
const dbApi = require('../db');

const REF_PATTERN = /^[A-Za-z0-9_-]{4,64}$/;

function safeReturnTo(value, fallback) {
  if (typeof value !== 'string') return fallback;
  if (!value.startsWith('/') || value.startsWith('//')) return fallback;
  return value;
}

function renderLogin({ returnTo, error, renewal }) {
  const page = renewal ? 'renewal' : 'login';
  const title = renewal ? '会话续期' : '登录';
  return layout({
    title: `虚构业务门户 · ${title}`,
    body: `<main style="max-width:420px;margin-top:64px">
  <div class="panel">
    <h2 id="auth-title">${title}</h2>
    <p class="notice" style="background:#f8fafc">本地虚构环境，仅可使用演示账号。续期需要重新提交账号密码，不会保留原先选择的业务条件。</p>
    ${error ? `<p class="error" id="auth-error">${escapeHtml(error)}</p>` : ''}
    <form id="${renewal ? 'renew-form' : 'login-form'}" method="post" action="${renewal ? '/portal/renew' : '/portal/login'}">
      <input type="hidden" name="return_to" value="${escapeHtml(returnTo)}">
      <label class="field" style="margin-bottom:10px">账号
        <input id="username" name="username" type="text" autocomplete="username" required>
      </label>
      <label class="field" style="margin-bottom:14px">密码
        <input id="password" name="password" type="password" autocomplete="current-password" required>
      </label>
      <button id="${renewal ? 'renew-button' : 'login-button'}" type="submit">${renewal ? '续期并返回' : '登录'}</button>
    </form>
  </div>
</main>`,
    header: `<header class="portal"><h1>虚构业务门户 · 结算报表</h1><span class="session" data-state="anonymous">未登录</span></header>`,
  }).replace('<body>', `<body data-page="${page}" data-render="${crypto.randomUUID()}">`);
}

function renderPortalShell({ user, sessionState, org, generations, error, notice }) {
  const periods = getPeriods();
  const selected = org || defaultOrg();
  const orgOptions = ORGS.map(
    (item) =>
      `<option value="${escapeHtml(item.code)}"${item.code === selected.code ? ' selected' : ''}>${escapeHtml(item.name)}（${escapeHtml(item.code)}）</option>`,
  ).join('');
  const renderId = crypto.randomUUID();
  return layout({
    title: '虚构业务门户 · 结算报表',
    header: portalHeader({
      user,
      sessionState,
      returnTo: `/portal?org=${selected.code}`,
    }),
    body: `<main>
  <div class="notice">业务条件：<strong>组织在外层选择</strong>，<strong>账期在下方报表子页面内选择</strong>。切换组织会整页重新加载子页面。</div>
  ${notice ? `<div class="notice" id="portal-notice">${escapeHtml(notice)}</div>` : ''}
  ${error ? `<p class="error" id="portal-error">${escapeHtml(error)}</p>` : ''}
  <form class="toolbar" id="org-form" method="get" action="/portal">
    <label class="field">组织
      <select id="org-select" name="org">${orgOptions}</select>
    </label>
    <button type="submit" class="secondary" id="org-apply">切换组织</button>
    <span class="session">当前组织：<code id="current-org">${escapeHtml(selected.code)}</code></span>
  </form>
  <iframe id="report-frame" name="report" title="结算报表子页面" src="/portal/report?org=${encodeURIComponent(selected.code)}"></iframe>
  <div class="panel" style="margin-top:16px">
    <h2>演示控制（仅本地虚构环境）</h2>
    <p class="notice">这两个按钮会真实地撤销当前会话的访问授予，用于演练“操作途中会话到期”。</p>
    <form method="post" action="/portal/demo/expire" style="display:inline">
      <input type="hidden" name="return_to" value="/portal?org=${escapeHtml(selected.code)}">
      <button type="submit" class="secondary" id="expire-now">模拟会话到期</button>
    </form>
    <form method="post" action="/portal/demo/arm-expire-after-generate" style="display:inline">
      <input type="hidden" name="return_to" value="/portal?org=${escapeHtml(selected.code)}">
      <button type="submit" class="secondary" id="arm-expire-after-generate">下一次生成后到期</button>
    </form>
  </div>
</main>`,
  }).replace('<body>', `<body data-page="portal" data-org="${escapeHtml(selected.code)}" data-render="${renderId}" data-session-state="${escapeHtml(sessionState)}">`);
}

function renderReportPage({ user, sessionState, org, period, generations, error, notice }) {
  const periods = getPeriods();
  const allowed = ORGS.filter((item) => orgAllowedForUser(user, item.code));
  const selectedOrg = org || allowed[0] || defaultOrg();
  const selectedPeriod = period || defaultPeriod();
  const periodOptions = periods
    .map(
      (value) =>
        `<option value="${escapeHtml(value)}"${value === selectedPeriod ? ' selected' : ''}>${escapeHtml(value)}</option>`,
    )
    .join('');
  const renderId = crypto.randomUUID();
  const historyRows = generations.length
    ? generations
        .map(
          (item) => `<tr data-generation-ref="${escapeHtml(item.run_key)}" data-generation-id="${escapeHtml(item.id)}">
        <td>${escapeHtml(item.period)}</td>
        <td><code>${escapeHtml(item.run_key)}</code></td>
        <td>${escapeHtml(item.filename)}</td>
        <td>${escapeHtml(item.download_count)} 次</td>
        <td><a id="download-${escapeHtml(item.id)}" data-download-ref="${escapeHtml(item.run_key)}" href="/portal/reports/${encodeURIComponent(item.id)}/download">下载</a></td>
      </tr>`,
        )
        .join('')
    : '<tr><td colspan="5" class="session">当前组织与账期还没有生成记录。</td></tr>';

  return layout({
    title: `${selectedOrg.short} · ${selectedPeriod} 结算报表`,
    body: `<main style="max-width:1040px">
  <div class="notice">子页面 · 当前组织 <code id="report-org">${escapeHtml(selectedOrg.code)}</code>，当前账期 <code id="report-period">${escapeHtml(selectedPeriod)}</code>。组织由外层页面决定，续期后子页面会回到默认组织与默认账期。</div>
  ${notice ? `<div class="notice" id="report-notice">${escapeHtml(notice)}</div>` : ''}
  ${error ? `<p class="error" id="report-error">${escapeHtml(error)}</p>` : ''}
  <form class="toolbar" id="period-form" method="get" action="/portal/report">
    <input type="hidden" name="org" value="${escapeHtml(selectedOrg.code)}">
    <label class="field">账期
      <select id="period-select" name="period">${periodOptions}</select>
    </label>
    <button type="submit" class="secondary" id="period-apply">切换账期</button>
  </form>
  <div class="panel">
    <h2>生成结算报表</h2>
    <form id="generate-form" method="post" action="/portal/reports/generate">
      <input type="hidden" name="org" value="${escapeHtml(selectedOrg.code)}">
      <input type="hidden" name="period" value="${escapeHtml(selectedPeriod)}">
      <label class="field" style="margin-bottom:12px">对账码（会写入文件，便于核对）
        <input id="report-ref" name="ref" type="text" value="${escapeHtml(`ui-${crypto.randomUUID().slice(0, 8)}`)}" pattern="[A-Za-z0-9_-]{4,64}" required>
      </label>
      <button type="submit" id="generate-button">生成并下载 CSV</button>
    </form>
  </div>
  <div class="panel" style="margin-top:16px">
    <h2>本组织 · 本账期的生成记录</h2>
    <table id="generation-history">
      <thead><tr><th>账期</th><th>对账码</th><th>文件名</th><th>已下载</th><th>操作</th></tr></thead>
      <tbody>${historyRows}</tbody>
    </table>
  </div>
</main>`,
  }).replace(
    '<body>',
    `<body data-page="report" data-org="${escapeHtml(selectedOrg.code)}" data-period="${escapeHtml(selectedPeriod)}" data-render="${renderId}" data-session-state="${escapeHtml(sessionState)}">`,
  );
}

function ensurePortalRouter(db) {
  const router = express.Router();

  router.get('/portal', (req, res) => {
    const { user, grant } = req.session;
    if (!user && !req.session.lastUsername) {
      return res.status(401).send(renderLogin({ returnTo: '/portal', renewal: false }));
    }
    if (!user) {
      return res.status(401).send(renderLogin({ returnTo: '/portal', renewal: false }));
    }
    const requested = typeof req.query.org === 'string' ? req.query.org : '';
    const org = getOrg(requested) && orgAllowedForUser(user, requested)
      ? getOrg(requested)
      : ORGS.find((item) => orgAllowedForUser(user, item.code)) || defaultOrg();
    res.send(
      renderPortalShell({
        user,
        sessionState: grantValid(req.session) ? 'active' : 'expired',
        org,
        error: typeof req.query.error === 'string' ? req.query.error : '',
      }),
    );
  });

  router.get('/portal/login', (req, res) => {
    const returnTo = safeReturnTo(req.query.return_to, '/portal');
    if (req.session.user && grantValid(req.session)) return res.redirect(returnTo);
    res.send(renderLogin({ returnTo, renewal: false }));
  });

  function authenticateForm(req, res, { renewal }) {
    const username = String(req.body.username || '');
    const password = String(req.body.password || '');
    const returnTo = safeReturnTo(req.body.return_to, renewal ? '/portal/report' : '/portal');
    const account = findAccount(username);
    if (!account || !verifyPassword(account, password)) {
      return res
        .status(401)
        .send(renderLogin({ returnTo, renewal, error: '账号或密码不正确（仅支持本地演示账号）。' }));
    }
    rotateSession(req, res, publicUser(account));
    res.redirect(returnTo);
  }

  router.post('/portal/login', (req, res) => {
    authenticateForm(req, res, { renewal: false });
  });

  router.post('/portal/renew', (req, res) => {
    // 续期只重建会话；不携带、也不恢复原先的 org/period 选择。
    authenticateForm(req, res, { renewal: true });
  });

  router.post('/portal/logout', (req, res) => {
    clearUser(req, res);
    req.session.lastUsername = '';
    res.redirect('/portal');
  });

  router.get('/portal/report', (req, res) => {
    const { user } = req.session;
    if (!user) {
      return res
        .status(401)
        .send(renderLogin({ returnTo: '/portal/report', renewal: Boolean(req.session.lastUsername) }));
    }
    const sessionState = grantValid(req.session) ? 'active' : 'expired';
    if (!grantValid(req.session)) {
      return res
        .status(401)
        .send(renderLogin({ returnTo: '/portal/report', renewal: true }));
    }
    const requestedOrg = typeof req.query.org === 'string' ? req.query.org : '';
    const org =
      getOrg(requestedOrg) && orgAllowedForUser(user, requestedOrg)
        ? getOrg(requestedOrg)
        : ORGS.find((item) => orgAllowedForUser(user, item.code)) || defaultOrg();
    const requestedPeriod = typeof req.query.period === 'string' ? req.query.period : '';
    const period = isPeriod(requestedPeriod) ? requestedPeriod : defaultPeriod();

    const generations = dbApi.listGenerations(db, { org: org.code, period });
    res.send(
      renderReportPage({
        user,
        sessionState,
        org,
        period,
        generations,
        error: typeof req.query.error === 'string' ? req.query.error : '',
        notice: typeof req.query.notice === 'string' ? req.query.notice : '',
      }),
    );
  });

  router.post('/portal/reports/generate', (req, res) => {
    const { user } = req.session;
    if (!user) return res.redirect('/portal/login?return_to=%2Fportal');
    const orgCode = String(req.body.org || '');
    const period = String(req.body.period || '');
    const ref = String(req.body.ref || '').trim();
    const org = getOrg(orgCode);

    if (!grantValid(req.session)) {
      // 会话已在提交前失效：此次提交不会生成任何报表。
      return res.redirect('/portal/report');
    }
    if (!org || !orgAllowedForUser(user, orgCode)) {
      return res.status(403).send('组织不在当前账号的授权范围内。');
    }
    if (!isPeriod(period)) {
      return res.status(400).send('账期不合法。');
    }
    if (!REF_PATTERN.test(ref)) {
      return res.status(400).send('对账码不合法（4-64 位字母、数字、下划线或连字符）。');
    }

    const id = `gen_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const filename = buildFilename({ org, period, ref });
    const csv = buildCsv({ org, period, ref });
    dbApi.createGeneration(db, {
      id,
      runKey: ref,
      org: org.code,
      period,
      reportType: REPORT_TYPE,
      filename,
      csv,
    });

    if (req.session.grant.revokeAfterGenerate) {
      // 报表已经生成并落库，但会话在返回文件之前到期。
      req.session.grant.revokeAfterGenerate = false;
      req.session.grant.revoked = true;
      return res.redirect('/portal/report');
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(csv);
  });

  router.get('/portal/reports/:id/download', (req, res) => {
    const { user } = req.session;
    if (!user || !grantValid(req.session)) {
      return res.redirect('/portal/report');
    }
    const generation = dbApi.getGeneration(db, req.params.id);
    if (!generation) return res.status(404).send('生成记录不存在。');
    if (!orgAllowedForUser(user, generation.org)) return res.status(403).send('无权下载该组织的报表。');
    dbApi.markGenerationDownloaded(db, generation.id);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${generation.filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(generation.csv);
  });

  router.get('/portal/api/generations', (req, res) => {
    if (!req.session.user || !grantValid(req.session)) {
      return res.status(401).json({ error: 'unauthenticated' });
    }
    const ref = typeof req.query.ref === 'string' ? req.query.ref : '';
    if (!REF_PATTERN.test(ref)) return res.status(400).json({ error: 'invalid_ref' });
    const row = dbApi.getGenerationByRunKey(db, ref);
    res.json({
      ref,
      found: Boolean(row),
      generation: row
        ? {
            id: row.id,
            org: row.org,
            period: row.period,
            reportType: row.report_type,
            filename: row.filename,
            status: row.status,
            createdAt: row.created_at,
          }
        : null,
    });
  });

  router.get('/portal/api/session', (req, res) => {
    res.json({
      authenticated: Boolean(req.session.user) && grantValid(req.session),
      user: req.session.user ? req.session.user.username : null,
      sessionState: req.session.user
        ? grantValid(req.session)
          ? 'active'
          : 'expired'
        : 'anonymous',
    });
  });

  function demoControl(req, res, mutate) {
    if (!req.session.user) return res.redirect('/portal/login?return_to=%2Fportal');
    mutate();
    res.redirect(safeReturnTo(req.body.return_to, '/portal'));
  }

  router.post('/portal/demo/expire', (req, res) => {
    demoControl(req, res, () => {
      req.session.grant.revoked = true;
      req.session.grant.revokeAfterGenerate = false;
    });
  });

  router.post('/portal/demo/arm-expire-after-generate', (req, res) => {
    demoControl(req, res, () => {
      req.session.grant.revokeAfterGenerate = true;
    });
  });

  return router;
}

module.exports = { ensurePortalRouter };
