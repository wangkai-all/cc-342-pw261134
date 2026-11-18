'use strict';

const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { ORGS, PERIODS, REPORT_TYPE } = require('../shared/catalog');
const dbApi = require('../db');
const { escapeHtml } = require('../portal/html');
const { isTerminal, persistedState, EPHEMERAL_PAGE_STATE } = require('./state-model');

const STYLE = `
  :root { --ink:#1b2430; --muted:#5d6b7a; --line:#d6dee8; --brand:#0f6b52; --warn:#8a5300; --bad:#a12727; }
  * { box-sizing:border-box; }
  body { margin:0; background:#f3f6f8; color:var(--ink); font-family:"Noto Sans CJK SC","WenQuanYi Zen Hei","DejaVu Sans",system-ui,sans-serif; }
  header.top { background:#fff; border-bottom:1px solid var(--line); padding:12px 22px; display:flex; gap:14px; align-items:center; }
  header.top h1 { font-size:16px; margin:0; }
  header.top .spacer { flex:1; }
  header.top a { color:var(--brand); font-size:13px; }
  main { max-width:1180px; margin:0 auto; padding:18px 22px 48px; }
  section.panel { background:#fff; border:1px solid var(--line); border-radius:10px; padding:16px; margin-bottom:16px; }
  section.panel h2 { font-size:15px; margin:0 0 12px; }
  form.grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); gap:12px; align-items:end; }
  label.field { display:flex; flex-direction:column; gap:4px; font-size:13px; color:var(--muted); }
  select, input[type=text], input[type=number] { padding:7px 9px; border:1px solid var(--line); border-radius:6px; font-size:14px; background:#fff; }
  button { padding:8px 14px; border-radius:6px; border:1px solid var(--brand); background:var(--brand); color:#fff; cursor:pointer; font-size:14px; }
  button.secondary { background:#fff; color:var(--brand); }
  button.tiny { padding:4px 9px; font-size:12px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th,td { text-align:left; padding:7px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
  code { background:#eef2f6; padding:1px 5px; border-radius:4px; font-size:12px; }
  .tag { display:inline-block; padding:1px 8px; border-radius:999px; font-size:12px; background:#e6f2ee; color:var(--brand); }
  .tag.failed { background:#fbeaea; color:var(--bad); }
  .tag.running, .tag.recovering { background:#fdf3e2; color:var(--warn); }
  .hint { font-size:12px; color:var(--muted); line-height:1.6; }
  .events { font-size:12px; color:var(--muted); max-height:240px; overflow:auto; }
  .events li { margin:2px 0; }
  .error { color:var(--bad); }
  details summary { cursor:pointer; font-size:13px; color:var(--brand); }
`;

function layout({ title, body, refreshSeconds = 0 }) {
  const refresh = refreshSeconds > 0 ? `<meta http-equiv="refresh" content="${refreshSeconds}">` : '';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${refresh}<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body data-page="console">${body}</body></html>`;
}

function orgOptions() {
  return ORGS.map((org) => `<option value="${escapeHtml(org.code)}">${escapeHtml(org.name)}（${escapeHtml(org.code)}）</option>`).join('');
}

function periodOptions() {
  return PERIODS.map((period) => `<option value="${escapeHtml(period)}">${escapeHtml(period)}</option>`).join('');
}

function statusTag(status) {
  return `<span class="tag ${escapeHtml(status)}">${escapeHtml(status)}</span>`;
}

function renderConsole({ config, runs, downloadsByRun, profiles }) {
  const rows = runs
    .map((run) => {
      const downloads = downloadsByRun[run.id] || [];
      const latest = downloads[downloads.length - 1];
      return `<tr data-run-id="${escapeHtml(run.id)}" data-run-status="${escapeHtml(run.status)}">
  <td><code>${escapeHtml(run.id)}</code><br><span class="hint">${escapeHtml(run.created_at)}</span></td>
  <td>${escapeHtml(run.org)}<br><span class="hint">${escapeHtml(run.period)}</span></td>
  <td>${statusTag(run.status)}<br><span class="hint">阶段：${escapeHtml(run.phase)}${run.attempts > 1 ? ` · 第 ${run.attempts} 次尝试` : ''}</span>
    ${run.error ? `<div class="error">${escapeHtml(run.error)}</div>` : ''}</td>
  <td>${
    latest
      ? `<div>${escapeHtml(latest.filename)}</div>
         <div class="hint">${latest.verified ? '内容已核对' : '未通过核对'} · ${escapeHtml(latest.size)} 字节</div>
         <a href="/downloads/${encodeURIComponent(latest.id)}">下载留档</a>`
      : '<span class="hint">尚未收到文件</span>'
  }</td>
  <td>
    <details><summary>事件（${run.eventCount}）</summary><ol class="events">${run.eventLines
      .map((line) => `<li>${escapeHtml(line)}</li>`)
      .join('')}</ol></details>
  </td>
  <td>
    ${!isTerminal(run.status) ? `<span class="hint">进行中</span>` : ''}
    ${isTerminal(run.status) ? `<button class="secondary tiny" data-resume="${escapeHtml(run.id)}">从库中条件恢复</button>` : ''}
    ${run.status === 'recovering' ? `<span class="hint">等待恢复</span>` : ''}
  </td>
</tr>`;
    })
    .join('');

  return layout({
    title: '采集台',
    body: `<header class="top">
  <h1>报表采集台 · 真实浏览器驱动</h1>
  <span class="spacer"></span>
  <a id="open-portal" href="/portal" target="_blank" rel="noopener">打开业务门户</a>
  <a href="/api/state-model" target="_blank">条件与状态边界</a>
</header>
<main>
  <section class="panel">
    <h2>发起采集</h2>
    <p class="hint">业务条件在这里选定并写入数据库。采集时浏览器只按库里的条件操作页面；续期或浏览器重启后不会沿用页面上的默认组织。</p>
    <form class="grid" id="create-run-form" method="post" action="/runs">
      <label class="field">组织<select name="org" id="run-org">${orgOptions()}</select></label>
      <label class="field">账期<select name="period" id="run-period">${periodOptions()}</select></label>
      <label class="field">备注（可选）<input type="text" name="label" id="run-label" placeholder="例如：月末对账"></label>
      <label class="field">会话演练
        <select name="expire_mode" id="run-expire">
          <option value="none">不触发续期</option>
          <option value="during_run">操作途中到期（点击生成前）</option>
          <option value="after_generate">生成已生效但返回前到期</option>
        </select>
      </label>
      <label class="field">浏览器演练
        <select name="close_at" id="run-close">
          <option value="">不关闭浏览器</option>
          <option value="before_apply">应用条件前关闭并重启</option>
          <option value="after_apply">应用条件后关闭并重启</option>
        </select>
      </label>
      <button type="submit" id="create-run">开始采集</button>
    </form>
  </section>

  <section class="panel">
    <h2>采集记录</h2>
    <p class="hint">共 ${runs.length} 条。点击“从库中条件恢复”会用同一个对账码重新核对既有生成记录，已生成就不再重复生成。</p>
    ${runs.length ? `<table id="run-table"><thead><tr><th>运行</th><th>业务条件</th><th>状态</th><th>下载内容</th><th>过程事件</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="hint" id="empty-runs">还没有采集记录。</p>'}
  </section>

  <section class="panel">
    <h2>浏览器 profile</h2>
    <p class="hint">采集浏览器使用持久化 profile。关闭后 Cookie 保留在磁盘，但页面、iframe、下拉框句柄全部作废；恢复时会重新启动浏览器并重新解析页面。</p>
    <table id="profile-table"><thead><tr><th>profile</th><th>状态</th><th>操作</th></tr></thead><tbody>
      ${profiles
        .map(
          (item) => `<tr data-profile="${escapeHtml(item.id)}"><td><code>${escapeHtml(item.id)}</code></td>
        <td>${item.open ? '运行中' : '已关闭'}</td>
        <td>
          <button class="secondary tiny" data-close-profile="${escapeHtml(item.id)}" ${item.open ? '' : 'disabled'}>关闭浏览器</button>
          <button class="secondary tiny" data-wake-profile="${escapeHtml(item.id)}" ${item.open ? 'disabled' : ''}>重新启动</button>
        </td></tr>`,
        )
        .join('')}
    </tbody></table>
    <p class="hint">提示：关闭浏览器后，在“采集记录”里对失败/中断的任务点“从库中条件恢复”，即可验证条件来自数据库而不是旧页面。</p>
  </section>

  <section class="panel">
    <h2>保存与恢复的边界</h2>
    <table>
      <thead><tr><th>内容</th><th>存放位置</th><th>恢复时如何使用</th></tr></thead>
      <tbody>
        <tr><td>组织、账期、报表类型</td><td>数据库 <code>conditions</code> / <code>runs</code></td><td>唯一事实来源，每一步操作后与页面核对</td></tr>
        <tr><td>幂等键（对账码）</td><td>数据库 <code>runs.run_key</code></td><td>生成前后查询门户是否已有生成记录，避免重复生成</td></tr>
        <tr><td>阶段与尝试次数</td><td>数据库 <code>runs.phase/attempts</code> + 事件</td><td>决定从“应用条件 / 续期 / 收取”哪一步继续</td></tr>
        <tr><td>iframe、Frame、Locator、下拉框值</td><td>不保存</td><td>每次操作都从当前页面重新解析；旧句柄一律丢弃</td></tr>
        <tr><td>登录 Cookie</td><td>浏览器 profile 目录</td><td>可能随时过期；过期就走门户续期表单</td></tr>
      </tbody>
    </table>
  </section>
</main>
<script>
(function () {
  async function post(url) {
    const response = await fetch(url, { method: 'POST', headers: { accept: 'application/json' } });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || ('HTTP ' + response.status));
    }
    return response.json().catch(function () { return {}; });
  }
  document.addEventListener('click', async function (event) {
    const resume = event.target.closest('[data-resume]');
    if (resume) {
      resume.disabled = true;
      try { await post('/api/runs/' + encodeURIComponent(resume.dataset.resume) + '/resume'); location.reload(); }
      catch (error) { alert('恢复失败：' + error.message); resume.disabled = false; }
      return;
    }
    const close = event.target.closest('[data-close-profile]');
    if (close) {
      close.disabled = true;
      try { await post('/api/profiles/' + encodeURIComponent(close.dataset.closeProfile) + '/close'); location.reload(); }
      catch (error) { alert('关闭失败：' + error.message); close.disabled = false; }
      return;
    }
    const wake = event.target.closest('[data-wake-profile]');
    if (wake) {
      wake.disabled = true;
      try { await post('/api/profiles/' + encodeURIComponent(wake.dataset.wakeProfile) + '/wake'); location.reload(); }
      catch (error) { alert('启动失败：' + error.message); wake.disabled = false; }
    }
  });
  const form = document.getElementById('create-run-form');
  if (form) {
    form.addEventListener('submit', async function (event) {
      event.preventDefault();
      const data = new FormData(form);
      const payload = {
        org: data.get('org'),
        period: data.get('period'),
        label: data.get('label') || '',
        expire_mode: data.get('expire_mode'),
        close_at: data.get('close_at'),
      };
      const button = document.getElementById('create-run');
      button.disabled = true;
      try {
        const response = await fetch('/api/runs', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!response.ok) throw new Error(await response.text());
        const created = await response.json();
        location.href = '/?run=' + encodeURIComponent(created.run.id);
      } catch (error) {
        alert('发起失败：' + error.message);
        button.disabled = false;
      }
    });
  }
})();
</script>`,
  });
}

function ensureConsoleRouter({ db, collector, config }) {
  const router = express.Router();

  function loadRuns() {
    const runs = dbApi.listRuns(db);
    return runs.map((run) => {
      const events = dbApi.listEvents(db, run.id);
      return {
        ...run,
        eventCount: events.length,
        eventLines: events
          .slice(-25)
          .map((event) => `#${event.seq} [${event.phase}] ${event.type} ${JSON.stringify(event.detail)}`),
      };
    });
  }

  function downloadsByRun() {
    const out = {};
    for (const run of dbApi.listRuns(db)) {
      out[run.id] = dbApi.listDownloads(db, run.id);
    }
    return out;
  }

  router.get('/runs/:id', (req, res) => {
    const run = dbApi.getRun(db, req.params.id);
    if (!run) return res.status(404).send('运行不存在。');
    const events = dbApi.listEvents(db, run.id);
    const downloads = dbApi.listDownloads(db, run.id);
    res.send(
      layout({
        title: `运行 ${run.id}`,
        // 进行中的任务自动刷新，避免看到过期状态；结束页不再刷新。
        refreshSeconds: isTerminal(run.status) ? 0 : 2,
        body: `<header class="top"><h1>运行详情</h1><span class="spacer"></span><a href="/">返回采集台</a><a href="/portal" target="_blank" rel="noopener">打开门户</a></header>
<main>
  <section class="panel">
    <h2>业务条件（来自数据库）</h2>
    <table id="run-conditions">
      <tbody>
        <tr><th>运行</th><td><code>${escapeHtml(run.id)}</code></td></tr>
        <tr><th>组织</th><td>${escapeHtml(run.org)}</td></tr>
        <tr><th>账期</th><td>${escapeHtml(run.period)}</td></tr>
        <tr><th>报表类型</th><td>${escapeHtml(run.report_type)}</td></tr>
        <tr><th>幂等键 / 对账码</th><td><code>${escapeHtml(run.run_key)}</code></td></tr>
        <tr><th>状态</th><td>${statusTag(run.status)} ${escapeHtml(run.phase)} · 尝试 ${escapeHtml(run.attempts)} 次</td></tr>
        <tr><th>计划</th><td>到期演练：${escapeHtml(run.expire_mode)} · 关闭浏览器：${escapeHtml(run.close_at || '无')}</td></tr>
        ${run.error ? `<tr><th>错误</th><td class="error">${escapeHtml(run.error)}</td></tr>` : ''}
      </tbody>
    </table>
    ${isTerminal(run.status) ? `<form method="post" action="/runs/${escapeHtml(run.id)}/resume" style="margin-top:12px"><button type="submit" class="secondary" id="resume-run">用库中条件再次恢复（核对既有生成记录）</button></form>` : ''}
  </section>
  <section class="panel">
    <h2>接收到的文件</h2>
    ${downloads.length ? `<table id="run-downloads"><thead><tr><th>文件</th><th>条件</th><th>校验</th><th>SHA-256</th><th>留档</th></tr></thead><tbody>${downloads
      .map(
        (item) => `<tr data-download-id="${escapeHtml(item.id)}"><td>${escapeHtml(item.filename)}</td>
      <td>${escapeHtml(item.org)} / ${escapeHtml(item.period)}</td>
      <td>${item.verified ? '与条件一致' : '不一致'}</td>
      <td><code>${escapeHtml(item.sha256.slice(0, 24))}…</code></td>
      <td><a href="/downloads/${encodeURIComponent(item.id)}">下载</a></td></tr>`,
      )
      .join('')}</tbody></table>` : '<p class="hint">尚未接收到文件。</p>'}
  </section>
  <section class="panel">
    <h2>过程事件</h2>
    <ol class="events" id="run-events">${events
      .map(
        (event) =>
          `<li data-seq="${escapeHtml(event.seq)}"><code>${escapeHtml(event.phase)}</code> ${escapeHtml(event.type)} <span class="hint">${escapeHtml(JSON.stringify(event.detail))}</span></li>`,
      )
      .join('')}</ol>
  </section>
</main>`,
      }),
    );
  });

  router.post('/runs/:id/resume', (req, res) => {
    const run = dbApi.getRun(db, req.params.id);
    if (!run) return res.status(404).send('运行不存在。');
    if (!isTerminal(run.status)) {
      return res.redirect(`/runs/${encodeURIComponent(run.id)}`);
    }
    dbApi.updateRun(db, run.id, { status: 'queued', phase: 'resume_requested', error: null });
    dbApi.appendEvent(db, run.id, {
      phase: 'queued',
      type: 'resume_requested',
      detail: { org: run.org, period: run.period, runKey: run.run_key },
    });
    collector.enqueue(run.id, 'default');
    res.redirect(`/runs/${encodeURIComponent(run.id)}`);
  });

  router.get('/', (req, res) => {
    res.send(
      renderConsole({
        config,
        runs: loadRuns(),
        downloadsByRun: downloadsByRun(),
        profiles: [{ id: 'default', open: collector.hosts.has('default') }],
      }),
    );
  });

  router.post('/runs', express.urlencoded({ extended: false }), async (req, res, next) => {
    try {
      const org = String(req.body.org || '');
      const period = String(req.body.period || '');
      const expireMode = ['none', 'during_run', 'after_generate'].includes(req.body.expire_mode)
        ? req.body.expire_mode
        : 'none';
      const closeAt = ['before_apply', 'after_apply'].includes(req.body.close_at)
        ? req.body.close_at
        : null;
      collector.validateCondition({ org, period });
      const condition = dbApi.createCondition(db, {
        org,
        period,
        reportType: REPORT_TYPE,
        label: String(req.body.label || ''),
      });
      const run = dbApi.createRun(db, {
        org,
        period,
        reportType: REPORT_TYPE,
        label: condition.label,
        conditionId: condition.id,
        expireMode,
        closeAt,
      });
      collector.enqueue(run.id, 'default');
      res.redirect('/');
    } catch (error) {
      next(error);
    }
  });

  router.post('/api/runs', express.json({ limit: '32kb' }), (req, res, next) => {
    try {
      const org = String(req.body.org || '');
      const period = String(req.body.period || '');
      const expireMode = ['none', 'during_run', 'after_generate'].includes(req.body.expire_mode)
        ? req.body.expire_mode
        : 'none';
      const closeAt = ['before_apply', 'after_apply'].includes(req.body.close_at)
        ? req.body.close_at
        : null;
      collector.validateCondition({ org, period });
      const condition = dbApi.createCondition(db, {
        org,
        period,
        reportType: REPORT_TYPE,
        label: String(req.body.label || ''),
      });
      const run = dbApi.createRun(db, {
        org,
        period,
        reportType: REPORT_TYPE,
        label: condition.label,
        conditionId: condition.id,
        expireMode,
        closeAt,
      });
      collector.enqueue(run.id, 'default');
      res.status(202).json({ run: dbApi.getRun(db, run.id), condition });
    } catch (error) {
      next(error);
    }
  });

  router.get('/api/runs', (req, res) => {
    res.json({ runs: loadRuns() });
  });

  router.get('/api/runs/:id', (req, res) => {
    const run = dbApi.getRun(db, req.params.id);
    if (!run) return res.status(404).json({ error: 'not_found' });
    res.json({
      run,
      events: dbApi.listEvents(db, run.id),
      downloads: dbApi.listDownloads(db, run.id),
    });
  });

  router.post('/api/runs/:id/resume', (req, res) => {
    const run = dbApi.getRun(db, req.params.id);
    if (!run) return res.status(404).json({ error: 'not_found' });
    if (!isTerminal(run.status)) {
      return res.status(409).json({ error: 'run_active' });
    }
    // 恢复只依赖数据库里的条件与幂等键。
    dbApi.updateRun(db, run.id, { status: 'queued', phase: 'resume_requested', error: null });
    dbApi.appendEvent(db, run.id, {
      phase: 'queued',
      type: 'resume_requested',
      detail: {
        org: run.org,
        period: run.period,
        runKey: run.run_key,
        attempts: run.attempts,
      },
    });
    collector.enqueue(run.id, 'default');
    res.status(202).json({ run: dbApi.getRun(db, run.id) });
  });

  router.post('/api/profiles/:id/close', async (req, res, next) => {
    try {
      await collector.closeProfile(req.params.id);
      res.json({ profile: req.params.id, open: false });
    } catch (error) {
      next(error);
    }
  });

  router.post('/api/profiles/:id/wake', async (req, res, next) => {
    try {
      const host = collector.hostFor(req.params.id);
      await host.launch();
      res.json({ profile: req.params.id, open: true });
    } catch (error) {
      next(error);
    }
  });

  router.get('/downloads/:id', (req, res) => {
    const record = dbApi.getDownload(db, req.params.id);
    if (!record) return res.status(404).send('下载记录不存在。');
    if (!fs.existsSync(record.path)) return res.status(410).send('留档文件已被移除。');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${record.filename}"`);
    fs.createReadStream(path.resolve(record.path)).pipe(res);
  });

  router.get('/api/state-model', (req, res) => {
    res.json({
      persisted: {
        business: ['org', 'period', 'report_type'],
        identity: ['run_key'],
        plan: ['expire_mode', 'close_at'],
        checkpoint: ['status', 'phase', 'attempts', 'run_events'],
      },
      sample: (() => {
        const latest = dbApi.listRuns(db)[0];
        return latest ? persistedState(latest) : null;
      })(),
      ephemeral: EPHEMERAL_PAGE_STATE,
      rules: [
        '恢复时只从数据库读取 org/period，并重新操作页面选择组织与账期',
        '续期后页面回到默认组织时，不沿用默认值',
        '点击生成前按 run_key 查询门户生成记录；已存在则只下载，不重复生成',
        '页面跳走或下载超时后，先核实生成记录，再决定是否重试',
      ],
      demoAccounts: {
        note: '仅本地虚构账号，密码见 README；无任何验证绕过',
      },
    });
  });

  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = /未知组织|账期格式/.test(String(error.message)) ? 400 : 500;
    res.status(status).json({ error: String(error.message || error) });
  });

  return router;
}

module.exports = { ensureConsoleRouter };
