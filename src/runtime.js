'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * 本机运行环境适配。
 *
 * 这个容器里没有系统级的 Chromium 依赖，项目自带的 .runtime/ 下有
 * 浏览器和最小动态库集合。这里只在相关环境变量尚未显式设置时补齐，
 * 不影响在普通机器上直接使用系统安装的 Playwright 浏览器。
 */
let configured = false;

function configureRuntimeEnv(root = path.resolve(__dirname, '..')) {
  if (configured) return;
  configured = true;

  const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(root, '.runtime', 'browsers');
  if (!process.env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync(browsers)) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = browsers;
  }

  const sysroot = process.env.PORTAL_SYSROOT || path.join(root, '.runtime', 'sysroot');
  if (fs.existsSync(sysroot)) {
    const libDirs = [
      path.join(sysroot, 'usr', 'lib', 'x86_64-linux-gnu'),
      path.join(sysroot, 'lib', 'x86_64-linux-gnu'),
    ].filter((dir) => fs.existsSync(dir));
    if (libDirs.length > 0) {
      const existing = process.env.LD_LIBRARY_PATH;
      process.env.LD_LIBRARY_PATH = [...libDirs, existing].filter(Boolean).join(':');
    }
    if (!process.env.FONTCONFIG_SYSROOT) {
      process.env.FONTCONFIG_SYSROOT = sysroot;
    }
  }
}

module.exports = { configureRuntimeEnv };
