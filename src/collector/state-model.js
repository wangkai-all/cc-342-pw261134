'use strict';

/**
 * 条件与页面操作的边界（显式模型）
 * ------------------------------------------------------------------
 * 持久化（数据库：conditions / runs）：
 *   - 业务条件：org、period、report_type —— 由操作者选择并落库，之后只从库里读。
 *   - 幂等键：run_key（同时作为门户的对账码 ref）—— 决定“这次业务动作”的身份。
 *   - 执行计划：expire_mode、close_at —— 演练场景，不是页面状态。
 *   - 检查点：phase、status、attempts —— 恢复时用来判断该从哪一步继续。
 *
 * 不持久化（每次恢复都重新获取）：
 *   - DOM 句柄、Frame 对象、Locator、iframe 的 contentWindow。
 *   - 下拉框当前值、页面 data-render、页面 URL 上的查询参数。
 *   - 登录会话 Cookie（只存在于浏览器 profile 里，且服务端随时可能判定过期）。
 *
 * 恢复规则：
 *   1. 只按数据库里的 org/period 重新走一遍“选择组织 → 选择账期”；
 *      绝不因为续期后页面回到默认组织就沿用默认值。
 *   2. 点击生成前先按 run_key 查询门户是否已有生成记录；有则下载既有文件，
 *      没有才生成。这样“动作已生效但页面跳走”时不会重复生成。
 */

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);

function isTerminal(status) {
  return TERMINAL_STATUSES.has(status);
}

function persistedState(run) {
  return {
    runId: run.id,
    org: run.org,
    period: run.period,
    reportType: run.report_type,
    runKey: run.run_key,
    expireMode: run.expire_mode,
    closeAt: run.close_at,
    phase: run.phase,
    status: run.status,
    attempts: run.attempts,
  };
}

const EPHEMERAL_PAGE_STATE = Object.freeze([
  'iframe element handle',
  'inner frame object',
  'select options snapshot',
  'current URL query string',
  'session cookie',
]);

module.exports = { TERMINAL_STATUSES, isTerminal, persistedState, EPHEMERAL_PAGE_STATE };
