'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * BrowserHost 只负责“浏览器进程 + 持久化 profile”。
 *
 * 关闭浏览器后再恢复时，Playwright 的 Context/Page/Frame/Locator 全部作废，
 * 唯一能跨进程保留的是 profile 目录里的 Cookie，以及数据库里的业务条件。
 * 因此恢复时一律重新 launch、重新取 Page，不复用任何旧对象。
 */
class BrowserHost {
  constructor({ profileDir, headless = true, logger = () => {} }) {
    this.profileDir = profileDir;
    this.headless = headless;
    this.logger = logger;
    this.context = null;
    this.chromium = null;
  }

  async launch() {
    if (this.context) return this.context;
    if (!this.chromium) {
      // 延迟到真正需要时再加载 Playwright（环境变量已在进程启动时配置好）。
      ({ chromium: this.chromium } = require('playwright'));
    }
    fs.mkdirSync(this.profileDir, { recursive: true });
    this.context = await this.chromium.launchPersistentContext(this.profileDir, {
      headless: this.headless,
      acceptDownloads: true,
      locale: 'zh-CN',
      viewport: { width: 1280, height: 900 },
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    this.context.setDefaultTimeout(8000);
    this.context.setDefaultNavigationTimeout(20000);
    this.logger('browser.launched', { profile: path.basename(this.profileDir) });
    return this.context;
  }

  async newPage() {
    const context = await this.launch();
    const pages = context.pages();
    const page = pages[0] || (await context.newPage());
    page.setDefaultTimeout(8000);
    return page;
  }

  async close() {
    if (!this.context) return;
    const context = this.context;
    this.context = null;
    try {
      await context.close();
      this.logger('browser.closed', {});
    } catch (error) {
      this.logger('browser.close_failed', { message: String(error && error.message) });
    }
  }
}

module.exports = { BrowserHost };
