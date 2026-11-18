'use strict';

const crypto = require('node:crypto');

/**
 * 极简内存会话。门户只服务本地演示，进程重启后会话失效，
 * 采集台会按正常登录表单重新登录，不做任何绕过。
 */
const SESSIONS = new Map();
const SESSION_COOKIE = 'portal_sid';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const GRANT_TTL_MS = 30 * 60 * 1000;

function newGrant() {
  return { validUntil: Date.now() + GRANT_TTL_MS, revoked: false, revokeAfterGenerate: false };
}

function grantValid(session) {
  return Boolean(
    session &&
      session.user &&
      session.grant &&
      !session.grant.revoked &&
      Date.now() < session.grant.validUntil,
  );
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

function cookieHeader(sid, maxAgeSeconds) {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(sid)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ].join('; ');
}

function createSessionRecord(seed = {}) {
  return {
    id: crypto.randomUUID().replace(/-/g, ''),
    user: null,
    lastUsername: '',
    grant: newGrant(),
    createdAt: Date.now(),
    ...seed,
  };
}

function getSessionRecord(sid) {
  const session = sid ? SESSIONS.get(sid) : null;
  if (!session) return null;
  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    SESSIONS.delete(session.id);
    return null;
  }
  return session;
}

function sessionMiddleware() {
  return (req, res, next) => {
    const cookies = parseCookies(req.headers.cookie);
    let session = getSessionRecord(cookies[SESSION_COOKIE]);
    if (!session) {
      session = createSessionRecord();
      SESSIONS.set(session.id, session);
      res.setHeader('Set-Cookie', cookieHeader(session.id, SESSION_TTL_MS / 1000));
    }
    req.session = session;
    next();
  };
}

function rotateSession(req, res, user) {
  if (req.session) SESSIONS.delete(req.session.id);
  const session = createSessionRecord({
    user,
    lastUsername: user.username,
    grant: newGrant(),
  });
  SESSIONS.set(session.id, session);
  req.session = session;
  res.setHeader('Set-Cookie', cookieHeader(session.id, SESSION_TTL_MS / 1000));
  return session;
}

function clearUser(req, res) {
  if (!req.session) return;
  req.session.user = null;
  req.session.grant = { validUntil: 0, revoked: true, revokeAfterGenerate: false };
  res.setHeader('Set-Cookie', cookieHeader(req.session.id, SESSION_TTL_MS / 1000));
}

setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, session] of SESSIONS) {
    if (session.createdAt < cutoff) SESSIONS.delete(id);
  }
}, 10 * 60 * 1000).unref();

module.exports = {
  SESSION_COOKIE,
  sessionMiddleware,
  rotateSession,
  clearUser,
  grantValid,
  newGrant,
  getSessionRecord,
};
