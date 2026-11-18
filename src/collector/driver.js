'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const REPORT_FRAME_SELECTOR = 'iframe[name="report"], iframe#report-frame';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function bodyInfo(target) {
  try {
    return await target.evaluate(() => {
      const body = document.body;
      return {
        kind: body ? body.dataset.page || 'unknown' : 'unknown',
        org: body ? body.dataset.org || '' : '',
        period: body ? body.dataset.period || '' : '',
        render: body ? body.dataset.render || '' : '',
        sessionState: body ? body.dataset.sessionState || '' : '',
        url: location.pathname + location.search,
      };
    });
  } catch {
    return null;
  }
}

/**
 * PortalDriver：只做“像人一样操作门户页面”的事。
 *
 * 所有定位器都在每次操作时重新从当前页面解析，内部不缓存 Frame/Locator：
 * iframe 会被组织切换、账期切换、会话续期整页替换，旧句柄必然失效。
 */
class PortalDriver {
  constructor({ host, baseUrl, credentials, logger = () => {}, timeouts = {} }) {
    this.host = host;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.credentials = credentials;
    this.logger = logger;
    this.page = null;
    this.downloadTimeoutMs = timeouts.download || 15000;
    this.navigationTimeoutMs = timeouts.navigation || 20000;
  }

  async openPage() {
    if (this.page && !this.page.isClosed()) return this.page;
    this.page = await this.host.newPage();
    return this.page;
  }

  async closePage() {
    if (!this.page) return;
    if (!this.page.isClosed()) await this.page.close().catch(() => {});
    this.page = null;
  }

  async goto(pathname) {
    const page = await this.openPage();
    await page.goto(`${this.baseUrl}${pathname}`, {
      waitUntil: 'domcontentloaded',
      timeout: this.navigationTimeoutMs,
    });
    await page.waitForLoadState('domcontentloaded');
    return page;
  }

  reportFrame() {
    return this.page.frameLocator(REPORT_FRAME_SELECTOR);
  }

  /** 枚举当前页面里所有 name=report 的 frame，逐个读取状态；不缓存对象。 */
  async reportFrameInfo() {
    if (!this.page || this.page.isClosed()) return null;
    for (const frame of this.page.frames()) {
      if (frame.name() !== 'report') continue;
      const info = await bodyInfo(frame);
      if (info) return { frame, info };
    }
    return null;
  }

  /** 处理顶层或子页面里的登录 / 续期表单（真实提交账号密码）。 */
  async submitAuthForm(scope, { kind }) {
    const username = scope.locator('input[name="username"]');
    const password = scope.locator('input[name="password"]');
    await username.waitFor({ state: 'visible', timeout: this.navigationTimeoutMs });
    await username.fill(this.credentials.username);
    await password.fill(this.credentials.password);
    const submit = scope.locator('form button[type="submit"]').first();
    this.logger('auth.submitted', { kind });
    await submit.click();
  }

  /**
   * 打开门户并确保处于已登录、会话有效的状态。
   * 只通过门户自己的登录/续期表单恢复，不写 Cookie、不调后门。
   */
  async ensureAuthenticated({ org } = {}) {
    const target = org ? `/portal?org=${encodeURIComponent(org)}` : '/portal';
    let page = await this.goto(target);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const info = await bodyInfo(page);
      if (info && (info.kind === 'login' || info.kind === 'renewal')) {
        await this.submitAuthForm(page, { kind: info.kind });
        await page.waitForLoadState('domcontentloaded');
        await sleep(150);
        continue;
      }
      if (info && info.kind === 'portal') {
        // 外层已登录，但子页面仍可能是续期页（会话被单独判定到期）。
        const frameState = await this.reportFrameInfo();
        if (frameState && ['login', 'renewal'].includes(frameState.info.kind)) {
          await this.submitAuthForm(frameState.frame, { kind: frameState.info.kind });
          await sleep(300);
          continue;
        }
        return page;
      }
      if (info && info.kind === 'report') {
        // 直接落在子页面（return_to 指向报表页）也算已登录。
        return page;
      }
      await sleep(200);
      page = await this.openPage();
    }

    throw new Error('无法通过门户登录/续期表单进入已登录状态');
  }

  /**
   * 按业务条件把页面驱动到目标状态。
   * 组织在外层选择，账期在内层选择；每一步之后都重新读取页面状态核对。
   */
  async applyConditions({ org, period, _depth = 0 }) {
    if (_depth > 3) throw new Error('续期反复替换页面，无法将业务条件稳定应用到报表子页面');
    const page = await this.ensureAuthenticated();

    // 外层：每次到达一个“未带组织参数”的门户首页，页面默认选中第一个组织。
    // 组织必须靠下拉框 + 提交按钮重新选出来，不能沿用页面默认值。
    await this.goto('/portal');
    const outer = await bodyInfo(page);
    if (!outer || outer.kind !== 'portal') {
      throw new Error(`选择组织时页面异常：${outer ? outer.kind : 'unreadable'}`);
    }

    const orgSelect = page.locator('#org-select');
    await orgSelect.waitFor({ state: 'visible' });
    const currentOrg = await orgSelect.inputValue().catch(() => '');
    let outerRender = outer.render;
    if (currentOrg !== org) {
      await orgSelect.selectOption(org);
      await Promise.all([
        page.waitForEvent('framenavigated', {
          predicate: (frame) => frame === page.mainFrame(),
          timeout: this.navigationTimeoutMs,
        }),
        page.locator('#org-apply').click(),
      ]);
      await page.waitForLoadState('domcontentloaded');
      const after = await bodyInfo(page);
      outerRender = after ? after.render : outerRender;
    }

    const appliedOrg = (await page.locator('#current-org').textContent().catch(() => '')).trim();
    if (appliedOrg !== org) {
      throw new Error(`组织选择未生效：期望 ${org}，页面为 ${appliedOrg || '空'}`);
    }

    // 子页面可能因切换组织而重建，也可能被续期页整页替换。
    let frameState = await this.waitForReportState({
      timeoutMs: this.navigationTimeoutMs,
      accept: (info) =>
        ['login', 'renewal'].includes(info.kind) ||
        (info.kind === 'report' && info.org === org),
      describe: `报表子页面（组织 ${org}）`,
    });
    if (frameState.info.kind === 'renewal' || frameState.info.kind === 'login') {
      await this.submitAuthForm(frameState.frame, { kind: frameState.info.kind });
      await sleep(300);
      // 续期后门户回到默认组织/账期 —— 整轮重新应用，不复用任何旧状态。
      return this.applyConditions({ org, period, _depth: _depth + 1 });
    }

    // 内层：账期下拉 + 提交，并且必须等到子页面真的换了一次渲染。
    const frame = this.reportFrame();
    const periodSelect = frame.locator('#period-select');
    await periodSelect.waitFor({ state: 'visible' });
    const currentPeriod = await periodSelect.inputValue().catch(() => '');
    if (currentPeriod !== period) {
      const renderBefore = frameState.info.render;
      await periodSelect.selectOption(period);
      await frame.locator('#period-apply').click();
      frameState = await this.waitForReportState({
        timeoutMs: this.navigationTimeoutMs,
        accept: (info) =>
          ['login', 'renewal'].includes(info.kind) ||
          (info.kind === 'report' && info.org === org && info.render !== renderBefore),
        describe: `账期切换后的子页面（${org}/${period}）`,
      });
      if (frameState.info.kind === 'renewal' || frameState.info.kind === 'login') {
        await this.submitAuthForm(frameState.frame, { kind: frameState.info.kind });
        await sleep(300);
        return this.applyConditions({ org, period, _depth: _depth + 1 });
      }
    }

    if (frameState.info.org !== org || frameState.info.period !== period) {
      throw new Error(
        `子页面业务条件不一致：期望 ${org}/${period}，实际 ${frameState.info.org}/${frameState.info.period}`,
      );
    }

    return { org, period, outerRender, frameInfo: frameState.info };
  }

  /**
   * 反复从当前页面重新解析子页面状态，直到满足 accept。
   * 不接受任何缓存对象：每次调用都重新枚举 frame。
   */
  async waitForReportState({ accept, describe = '报表子页面', timeoutMs = 10000 }) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      const state = await this.reportFrameInfo();
      if (state) {
        last = state;
        if (!accept || accept(state.info)) return state;
      }
      await sleep(100);
    }
    if (last) {
      return last;
    }
    throw new Error(`等待${describe}超时`);
  }

  /** 通过真实页面请求查询门户是否已为某个对账码生成过报表。 */
  async queryGeneration(ref) {
    const page = await this.openPage();
    const result = await page.evaluate(async (value) => {
      const response = await fetch(`/portal/api/generations?ref=${encodeURIComponent(value)}`, {
        headers: { accept: 'application/json' },
        cache: 'no-store',
      });
      if (response.status === 401) return { status: 401 };
      if (!response.ok) return { status: response.status };
      return { status: response.status, body: await response.json() };
    }, ref);
    return result;
  }

  /**
   * 在报表子页面里点击“生成并下载”，同时监听下载事件与续期替换。
   * 返回：{type:'download', download} | {type:'renewal'} | {type:'timeout'} | {type:'error', error}
   */
  async generate({ ref, timeoutMs = this.downloadTimeoutMs }) {
    const page = await this.openPage();
    const frame = this.reportFrame();
    const refInput = frame.locator('#report-ref');
    await refInput.waitFor({ state: 'visible', timeout: this.navigationTimeoutMs });
    await refInput.fill(ref);

    let download = null;
    let downloadError = null;
    const onDownload = (item) => {
      download = item;
    };
    const onPageError = (error) => {
      downloadError = error;
    };
    page.on('download', onDownload);
    page.on('pageerror', onPageError);

    try {
      await frame.locator('#generate-button').click({ timeout: this.navigationTimeoutMs });
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (download) return { type: 'download', download };
        const state = await this.reportFrameInfo();
        if (state && ['login', 'renewal'].includes(state.info.kind)) {
          // 动作可能已经在服务端生效（生成后到期），调用方负责核实。
          return { type: 'renewal', kind: state.info.kind };
        }
        if (downloadError) return { type: 'error', error: downloadError };
        await sleep(100);
      }
      return { type: 'timeout' };
    } finally {
      page.off('download', onDownload);
      page.off('pageerror', onPageError);
    }
  }

  /**
   * 从报表页面的“生成记录”里点击下载既有文件（不重新生成）。
   * 找不到记录时回退到生成记录的直接下载地址。
   */
  async downloadExisting({ ref, timeoutMs = this.downloadTimeoutMs }) {
    const page = await this.openPage();
    const state = await this.waitForReportState({
      timeoutMs: this.navigationTimeoutMs,
      accept: (info) => true,
    });
    if (['login', 'renewal'].includes(state.info.kind)) {
      return { type: 'renewal', kind: state.info.kind };
    }

    const link = this.reportFrame().locator(`a[data-download-ref="${ref}"]`).first();
    const hasLink = (await link.count()) > 0;

    let download = null;
    const onDownload = (item) => {
      download = item;
    };
    page.on('download', onDownload);
    try {
      if (hasLink) {
        await link.click({ timeout: this.navigationTimeoutMs });
      } else {
        const generation = await this.queryGeneration(ref);
        if (generation.status !== 200 || !generation.body || !generation.body.found) {
          return { type: 'missing' };
        }
        try {
          await page.goto(
            `${this.baseUrl}/portal/reports/${generation.body.generation.id}/download`,
            { waitUntil: 'domcontentloaded', timeout: this.navigationTimeoutMs },
          );
        } catch (error) {
          // 直接命中附件时 Chromium 以“开始下载”中止导航，这本身不是失败；
          // 真正的结果由下面的 download 事件判断。
          if (!/Download is starting/i.test(String(error && error.message))) throw error;
        }
      }
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (download) return { type: 'download', download };
        const current = await this.reportFrameInfo();
        if (current && ['login', 'renewal'].includes(current.info.kind)) {
          return { type: 'renewal', kind: current.info.kind };
        }
        await sleep(100);
      }
      return { type: 'timeout' };
    } finally {
      page.off('download', onDownload);
    }
  }

  /** 打开同会话的第二个标签页，真实点击门户上的演示到期按钮。 */
  async triggerExpiry({ org, mode }) {
    const context = await this.host.launch();
    const page = await context.newPage();
    try {
      await page.goto(`${this.baseUrl}/portal?org=${encodeURIComponent(org)}`, {
        waitUntil: 'domcontentloaded',
        timeout: this.navigationTimeoutMs,
      });
      const info = await bodyInfo(page);
      if (!info || info.kind !== 'portal') {
        throw new Error(`触发到期时页面异常：${info ? info.kind : 'unreadable'}`);
      }
      const buttonId = mode === 'after_generate' ? '#arm-expire-after-generate' : '#expire-now';
      await Promise.all([
        page.waitForEvent('framenavigated', {
          predicate: (frame) => frame === page.mainFrame(),
          timeout: this.navigationTimeoutMs,
        }),
        page.locator(buttonId).click(),
      ]);
      await page.waitForLoadState('domcontentloaded');
      this.logger('session.expiry_triggered', { mode });
      return true;
    } finally {
      await page.close().catch(() => {});
    }
  }

  async saveDownload(download, destination) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    await download.saveAs(destination);
    const buffer = fs.readFileSync(destination);
    return {
      path: destination,
      filename: download.suggestedFilename(),
      size: buffer.length,
      sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
      text: buffer.toString('utf8'),
    };
  }
}

module.exports = { PortalDriver, sleep };
