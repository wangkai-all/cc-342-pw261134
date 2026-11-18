'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { BrowserHost } = require('./browser');
const { PortalDriver, sleep } = require('./driver');

/** 等待 promise，但最多等 ms 毫秒；超时后清理定时器，避免拖住事件循环。 */
function withTimeout(promise, ms) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
const { isTerminal, persistedState } = require('./state-model');
const { inspectContent, parseCsv } = require('../portal/report');
const dbApi = require('../db');
const { getOrg, isPeriod } = require('../shared/catalog');

/**
 * 采集台编排器。
 *
 * 一次 run 的步骤：
 *   1. 把业务条件锁进数据库（之后不再从页面读取）。
 *   2. 用真实浏览器登录/续期，按条件驱动页面，核对组织与账期。
 *   3. 点击生成前先核实是否已生成（run_key 为幂等键），避免重复生成。
 *   4. 接收下载、核对内容、落库。
 *   5. 任何一处需要恢复，都只从数据库读条件并重新解析页面。
 */
class Collector {
  constructor({ db, config, logger = () => {} }) {
    this.db = db;
    this.config = config;
    this.logger = logger;
    this.hosts = new Map(); // profileId -> BrowserHost
    this.controllers = new Map(); // profileId -> {host, driver}
    this.queue = Promise.resolve();
    this.running = 0;
    this.closed = false;
    fs.mkdirSync(config.downloadsDir, { recursive: true });
    fs.mkdirSync(config.profilesDir, { recursive: true });
  }

  event(runId, phase, type, detail = {}) {
    dbApi.appendEvent(this.db, runId, { phase, type, detail });
    this.logger(`run.${type}`, { runId, phase, ...detail });
  }

  setPhase(runId, status, phase, extra = {}) {
    dbApi.updateRun(this.db, runId, { status, phase, ...extra });
  }

  hostFor(profileId) {
    let host = this.hosts.get(profileId);
    if (!host) {
      host = new BrowserHost({
        profileDir: path.join(this.config.profilesDir, profileId),
        headless: this.config.headless,
        logger: this.logger,
      });
      this.hosts.set(profileId, host);
    }
    return host;
  }

  driverFor(profileId) {
    const controllerKey = profileId;
    let controller = this.controllers.get(controllerKey);
    if (controller) return controller;
    const host = this.hostFor(profileId);
    const driver = new PortalDriver({
      host,
      baseUrl: this.config.portalBaseUrl,
      credentials: this.config.portal,
      logger: this.logger,
      timeouts: { navigation: this.config.navigationTimeoutMs },
    });
    controller = { host, driver };
    this.controllers.set(controllerKey, controller);
    return controller;
  }

  async closeProfile(profileId) {
    const controller = this.controllers.get(profileId);
    this.controllers.delete(profileId);
    if (controller) {
      await controller.driver.closePage();
      await controller.host.close();
    }
    const host = this.hosts.get(profileId);
    this.hosts.delete(profileId);
    if (host) await host.close();
  }

  /** 只关闭浏览器（页面与进程），采集台继续可接收恢复请求。 */
  async closeBrowsers() {
    await withTimeout(this.queue, 30000);
    for (const profileId of [...this.controllers.keys(), ...this.hosts.keys()]) {
      await this.closeProfile(profileId);
    }
  }

  async closeAll() {
    // 先等在跑的采集结束，否则关掉的浏览器会被正在执行的 run 重新启动。
    await withTimeout(this.queue, 30000);
    this.closed = true;
    for (const profileId of [...this.controllers.keys(), ...this.hosts.keys()]) {
      await this.closeProfile(profileId);
    }
  }

  validateCondition({ org, period }) {
    if (!getOrg(org)) throw new Error(`未知组织：${org}`);
    if (!isPeriod(period)) throw new Error(`账期不合法：${period}`);
  }

  async enqueue(runId, profileId) {
    if (this.closed) {
      dbApi.updateRun(this.db, runId, {
        status: 'cancelled',
        phase: 'shutdown',
        error: '采集台正在关闭，未执行',
      });
      return Promise.resolve();
    }
    const task = this.queue.then(async () => {
      this.running += 1;
      try {
        await this.execute(runId, profileId);
      } finally {
        this.running -= 1;
      }
    });
    // 队列本身不因单次失败而中断。
    this.queue = task.catch(() => {});
    return task;
  }

  async execute(runId, profileId) {
    const run = dbApi.getRun(this.db, runId);
    if (!run || isTerminal(run.status)) return;
    if (this.closed) return;
    const started = new Date().toISOString();
    this.setPhase(runId, 'running', 'starting', {
      started_at: run.started_at || started,
      attempts: run.attempts + 1,
      error: null,
    });
    this.event(runId, 'starting', 'conditions_locked', persistedState(run));

    const { driver } = this.driverFor(profileId);
    try {
      await this.driveAndCollect({ runId, run, driver, profileId });
    } catch (error) {
      if (this.handleRecoverable({ runId, run, driver, profileId, error })) return;
      const message = String((error && error.message) || error);
      this.setPhase(runId, 'failed', 'failed', {
        error: message,
        finished_at: new Date().toISOString(),
      });
      this.event(runId, 'failed', 'failed', { message });
    }
  }

  handleRecoverable({ runId, run, driver, profileId, error }) {
    const message = String((error && error.message) || error);
    const lost = /Target page, context or browser has been closed|Target closed|Browser has been closed|frame was detached|Execution context was destroyed|Protocol error/i.test(
      message,
    );
    if (!lost) return false;
    this.setPhase(runId, 'recovering', 'browser_lost', { error: message });
    this.event(runId, 'recovering', 'browser_lost', { message });
    // 丢弃所有旧句柄与旧浏览器，从数据库条件重新开始。
    driver.closePage().catch(() => {});
    driver.host.close().catch(() => {});
    this.controllers.delete(profileId);
    this.hosts.delete(profileId);
    const next = () => this.enqueue(runId, profileId);
    setTimeout(next, 0);
    return true;
  }

  /**
   * 计划内的“关闭浏览器再恢复”。关闭的是真实浏览器进程与页面，
   * 然后由同一个 profile 重新启动；条件仍只来自数据库。
   */
  async maybeCloseBrowser({ runId, run, driver }) {
    if (!run.close_at) return false;
    const already = dbApi.countEvents(this.db, runId, 'browser_closed_by_plan') > 0;
    if (already) return false;
    this.event(runId, 'closing', 'browser_closed_by_plan', { closeAt: run.close_at });
    await driver.closePage();
    await driver.host.close();
    await sleep(150);
    this.event(runId, 'reopening', 'browser_reopened', { closeAt: run.close_at });
    return true;
  }

  async driveAndCollect({ runId, run, driver, profileId }) {
    const org = { code: run.org, ...(getOrg(run.org) || {}) };
    const plan = {
      expireMode: run.expire_mode,
      closeAt: run.close_at,
    };

    // 先确保登录（也是“关闭浏览器后恢复”的第一步：重新拿页面，不缓存旧句柄）。
    await driver.ensureAuthenticated({ org: run.org });

    // 计划中的“关闭浏览器再恢复”：动作之前先关闭，完全靠持久化条件恢复。
    if (plan.closeAt === 'before_apply') {
      await this.maybeCloseBrowser({ runId, run, driver });
      await driver.ensureAuthenticated({ org: run.org });
      this.event(runId, 'reopening', 'ready_after_restart', { stage: 'before_apply' });
    }

    // 动作前的恢复检查点：只可能在更早一次尝试里已经点过生成。
    const existingBefore = await this.verifyGeneration({ runId, run, driver });
    if (existingBefore.found) {
      this.event(runId, 'applying', 'reused_existing_generation', {
        ref: run.run_key,
        reason: '进入本轮前已存在同一对账码的生成记录',
      });
      return this.collectExisting({ runId, run, driver, profileId, generation: existingBefore.generation });
    }

    this.setPhase(runId, 'running', 'applying_conditions');
    const applied = await driver.applyConditions({ org: run.org, period: run.period });
    this.event(runId, 'applying_conditions', 'conditions_applied', {
      org: applied.org,
      period: applied.period,
      frameOrg: applied.frameInfo.org,
      framePeriod: applied.frameInfo.period,
      frameRender: applied.frameInfo.render,
    });

    if (plan.closeAt === 'after_apply') {
      await this.maybeCloseBrowser({ runId, run, driver });
      this.setPhase(runId, 'running', 'reapplying_after_restart');
      const reapplied = await driver.applyConditions({ org: run.org, period: run.period });
      this.event(runId, 'reapplying_after_restart', 'conditions_reapplied', {
        org: reapplied.org,
        period: reapplied.period,
        frameRender: reapplied.frameInfo.render,
      });
    }

    if (plan.expireMode !== 'none') {
      this.setPhase(runId, 'running', 'triggering_expiry');
      await driver.triggerExpiry({ org: run.org, mode: plan.expireMode });
      this.event(runId, 'triggering_expiry', 'expiry_triggered', { mode: plan.expireMode });
    }

    this.setPhase(runId, 'running', 'generating');
    const result = await driver.generate({ ref: run.run_key });
    this.event(runId, 'generating', 'generate_result', { type: result.type });

    if (result.type === 'download') {
      const received = await this.receiveDownload({ runId, run, driver, profileId, download: result.download });
      return received;
    }

    if (result.type === 'renewal') {
      // 动作可能已生效：先核实门户是否已有这个对账码的生成记录，再决定是否重试点击。
      const check = await this.verifyGeneration({ runId, run, driver });
      if (check.found) {
        return this.collectExisting({ runId, run, driver, profileId, generation: check.generation, recovered: true });
      }

      this.event(runId, 'generating', 'action_not_effective', { reason: 'renewal 页面且未查到生成记录' });
      return this.retryAfterRenewal({ runId, run, driver, profileId });
    }

    if (result.type === 'timeout' || result.type === 'error') {
      // 超时同样可能是“点击已生效但下载未被观察到”，先核实。
      const check = await this.verifyGeneration({ runId, run, driver });
      if (check.found) {
        return this.collectExisting({ runId, run, driver, profileId, generation: check.generation, recovered: true });
      }
      throw new Error(`生成未产生下载：${result.type}${result.error ? ` (${result.error.message})` : ''}`);
    }

    throw new Error(`未知的生成结果：${result.type}`);
  }

  async retryAfterRenewal({ runId, run, driver, profileId, attempt = 1 }) {
    this.setPhase(runId, 'running', 'renewing');
    await driver.ensureAuthenticated({ org: run.org });
    this.event(runId, 'renewing', 'session_renewed', { attempt });

    this.setPhase(runId, 'running', 'reapplying_conditions');
    const reapplied = await driver.applyConditions({ org: run.org, period: run.period });
    if (reapplied.org !== run.org || reapplied.period !== run.period) {
      throw new Error('续期后未能恢复业务条件');
    }
    this.event(runId, 'reapplying_conditions', 'conditions_reapplied_after_renewal', {
      org: reapplied.org,
      period: reapplied.period,
      frameRender: reapplied.frameInfo.render,
    });

    // 再核实一次：动作生效但不能重复生成。
    const check = await this.verifyGeneration({ runId, run, driver });
    if (check.found) {
      return this.collectExisting({ runId, run, driver, profileId, generation: check.generation, recovered: true });
    }

    if (attempt > 2) throw new Error('续期后重试生成仍失败');

    this.setPhase(runId, 'running', 'generating_after_renewal');
    const result = await driver.generate({ ref: run.run_key });
    this.event(runId, 'generating_after_renewal', 'generate_result', { type: result.type, attempt });
    if (result.type === 'download') {
      return this.receiveDownload({ runId, run, driver, profileId, download: result.download });
    }
    if (result.type === 'renewal') {
      return this.retryAfterRenewal({ runId, run, driver, profileId, attempt: attempt + 1 });
    }
    const finalCheck = await this.verifyGeneration({ runId, run, driver });
    if (finalCheck.found) {
      return this.collectExisting({ runId, run, driver, profileId, generation: finalCheck.generation, recovered: true });
    }
    throw new Error(`续期后生成仍无结果：${result.type}`);
  }

  /**
   * 核实某一轮是否已在门户生成过报表。
   * 若查询时恰好会话到期（401），先走正常续期表单，再查一次；
   * 不会把“查不到”误判成“没生成”。
   */
  async verifyGeneration({ runId, run, driver }) {
    const first = await this.checkGeneration({ runId, driver, ref: run.run_key });
    if (!first.needsAuth) return first;
    await driver.ensureAuthenticated({ org: run.org });
    return this.checkGeneration({ runId, driver, ref: run.run_key });
  }

  async checkGeneration({ runId, driver, ref }) {
    const result = await driver.queryGeneration(ref);
    if (result.status === 401) {
      this.event(runId, 'verifying', 'verification_unauthenticated', { ref });
      return { needsAuth: true, found: false, generation: null };
    }
    if (result.status !== 200 || !result.body) {
      this.event(runId, 'verifying', 'verification_failed', { ref, status: result.status });
      return { needsAuth: false, found: false, generation: null };
    }
    const generation = result.body.generation;
    if (generation) {
      this.event(runId, 'verifying', 'generation_exists', {
        ref,
        status: generation.status,
        org: generation.org,
        period: generation.period,
        filename: generation.filename,
      });
    } else {
      this.event(runId, 'verifying', 'generation_absent', { ref });
    }
    return { needsAuth: false, found: Boolean(result.body.found), generation };
  }

  async collectExisting({ runId, run, driver, profileId, generation, recovered = true, attempt = 1 }) {
    if (attempt > 2) throw new Error('已有生成记录，但多次续期后仍无法取回文件');
    this.setPhase(runId, 'running', 'collecting_existing');
    // 即使只是取回已生成的文件，也先从业务条件恢复页面操作状态；
    // 这样不会因为续期后页面回到默认组织/账期而下载错文件。
    const applied = await driver.applyConditions({ org: run.org, period: run.period });
    this.event(runId, 'collecting_existing', 'conditions_restored_for_collection', {
      org: applied.org,
      period: applied.period,
      frameOrg: applied.frameInfo.org,
      framePeriod: applied.frameInfo.period,
      generationId: generation && generation.id,
    });
    const result = await driver.downloadExisting({ ref: run.run_key });
    this.event(runId, 'collecting_existing', 'download_attempt', { type: result.type });
    if (result.type === 'download') {
      return this.receiveDownload({
        runId,
        run,
        driver,
        profileId,
        download: result.download,
        recovered,
      });
    }
    if (result.type === 'renewal') {
      await driver.ensureAuthenticated({ org: run.org });
      await driver.applyConditions({ org: run.org, period: run.period });
      return this.collectExisting({ runId, run, driver, profileId, generation, recovered, attempt: attempt + 1 });
    }
    throw new Error(`已有生成记录但下载失败：${result.type}`);
  }

  async receiveDownload({ runId, run, driver, download, recovered = false }) {
    this.setPhase(runId, 'running', 'receiving_download');
    const safeName = `${run.id}-${Date.now()}-${download.suggestedFilename().replace(/[^A-Za-z0-9._-]/g, '_')}`;
    const destination = path.join(this.config.downloadsDir, run.id, safeName);
    const saved = await driver.saveDownload(download, destination);

    const org = getOrg(run.org);
    const inspection = inspectContent(saved.text, {
      org,
      period: run.period,
      ref: run.run_key,
    });
    const header = parseCsv(saved.text).header;

    this.event(runId, 'receiving_download', 'download_received', {
      filename: saved.filename,
      storedAs: safeName,
      size: saved.size,
      sha256: saved.sha256.slice(0, 16),
      suggested: download.suggestedFilename(),
      verified: inspection.ok,
    });

    // 下载内容与业务条件的一致性：既校验文件名里的组织/账期，也校验 CSV 每一行。
    const expectedPrefix = `settlement_${run.org.toLowerCase()}_${run.period}_`;
    const filenameMatches = saved.filename.startsWith(expectedPrefix);
    const conditionMatches = inspection.ok && filenameMatches;

    if (!conditionMatches) {
      this.event(runId, 'receiving_download', 'condition_mismatch', {
        reason: inspection.reason || '文件名与业务条件不符',
        filename: saved.filename,
        expectedPrefix,
        header,
      });
      throw new Error(
        `下载内容与业务条件不一致：${inspection.reason || 'file name mismatch'}（文件 ${saved.filename}）`,
      );
    }

    const record = dbApi.createDownload(this.db, {
      runId,
      filename: saved.filename,
      path: saved.path,
      sha256: saved.sha256,
      size: saved.size,
      org: run.org,
      period: run.period,
      reportType: run.report_type,
      runKey: run.run_key,
      verified: true,
      source: recovered ? 'recovered' : 'live',
      preview: saved.text.split('\n').slice(0, 3).join('\n'),
    });

    this.setPhase(runId, 'succeeded', 'done', {
      finished_at: new Date().toISOString(),
      error: null,
      note: recovered ? '通过既有生成记录恢复收取' : '本轮直接下载',
    });
    this.event(runId, 'done', 'succeeded', {
      downloadId: record.id,
      filename: saved.filename,
      rows: inspection.rowCount,
      recovered,
      conditionMatches,
    });
    return record;
  }
}

module.exports = { Collector };
