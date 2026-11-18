'use strict';

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLE = `
  :root { color-scheme: light; --ink:#1f2933; --muted:#5f6b7a; --line:#d7dee8; --brand:#2456a6; --warn:#9a5b00; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: "Noto Sans CJK SC", "WenQuanYi Zen Hei", "DejaVu Sans", system-ui, sans-serif; color:var(--ink); background:#f4f6f9; }
  header.portal { display:flex; align-items:center; gap:16px; padding:12px 20px; background:#fff; border-bottom:1px solid var(--line); }
  header.portal h1 { font-size:16px; margin:0; }
  header.portal .spacer { flex:1; }
  .session { font-size:13px; color:var(--muted); }
  .session[data-state="expired"] { color:var(--warn); font-weight:600; }
  main { padding:20px; max-width:1120px; margin:0 auto; }
  .toolbar { display:flex; gap:12px; align-items:flex-end; flex-wrap:wrap; margin-bottom:16px; }
  label.field { display:flex; flex-direction:column; gap:4px; font-size:13px; color:var(--muted); }
  select, input[type=text], input[type=password] { padding:7px 9px; border:1px solid var(--line); border-radius:6px; background:#fff; font-size:14px; min-width:180px; }
  button { padding:8px 14px; border:1px solid var(--brand); background:var(--brand); color:#fff; border-radius:6px; font-size:14px; cursor:pointer; }
  button.secondary { background:#fff; color:var(--brand); }
  iframe#report-frame { width:100%; height:640px; border:1px solid var(--line); border-radius:8px; background:#fff; }
  .notice { padding:10px 12px; background:#fff; border:1px solid var(--line); border-radius:8px; font-size:13px; color:var(--muted); margin-bottom:12px; }
  .panel { background:#fff; border:1px solid var(--line); border-radius:8px; padding:16px; }
  .panel h2 { font-size:15px; margin:0 0 12px; }
  table { border-collapse:collapse; width:100%; font-size:13px; }
  th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
  code { background:#eef2f7; padding:1px 5px; border-radius:4px; }
  .error { color:#a11; }
  .badge { display:inline-block; padding:2px 8px; border-radius:999px; font-size:12px; background:#e8f0fb; color:var(--brand); }
`;

function layout({ title, body, header = '' }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
${header}
${body}
</body>
</html>`;
}

function portalHeader({ user, sessionState, returnTo }) {
  const who = user ? `${escapeHtml(user.displayName)}（${escapeHtml(user.username)}）` : '未登录';
  return `<header class="portal">
  <h1>虚构业务门户 · 结算报表</h1>
  <span class="session" id="session-state" data-state="${escapeHtml(sessionState)}">${
    sessionState === 'expired' ? '会话已到期，需续期' : sessionState === 'anonymous' ? '尚未登录' : '会话有效'
  }</span>
  <span class="spacer"></span>
  <span class="session">${who}</span>
  ${
    user
      ? `<form method="post" action="/portal/demo/expire" style="margin:0">
           <input type="hidden" name="return_to" value="${escapeHtml(returnTo)}">
           <button type="submit" class="secondary" id="expire-session">模拟会话到期</button>
         </form>
         <form method="post" action="/portal/logout" style="margin:0">
           <button type="submit" class="secondary" id="logout">退出</button>
         </form>`
      : ''
  }
</header>`;
}

module.exports = { escapeHtml, layout, portalHeader };
