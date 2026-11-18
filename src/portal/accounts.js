'use strict';

const crypto = require('node:crypto');

/**
 * 仅用于本地演示的虚构账号。密码以 scrypt(salt) 存储，登录时正常校验；
 * 采集台也只会通过门户登录表单提交账号密码，不会注入会话或跳过验证。
 */
const ACCOUNTS = Object.freeze([
  {
    username: 'demo@example.test',
    displayName: '演示操作员',
    orgs: ['ORG-ALPHA', 'ORG-BETA', 'ORG-GAMMA'],
    salt: '58f73ca7e12c57b609f78d38d4ef6813',
    hash: 'f3463d4b01df74b904ebbaa1d622c297c701975485caac6025566b83fac07e75',
  },
  {
    username: 'viewer@example.test',
    displayName: '只读观察员',
    orgs: ['ORG-ALPHA'],
    salt: '57fbbd94b9f3bda5a26357e34dc9881c',
    hash: 'f1b2a6253603d6cb23a0058f4190b63f6f230931759553a9f8650e3169cf3069',
  },
]);

function findAccount(username) {
  if (typeof username !== 'string') return null;
  const normalized = username.trim().toLowerCase();
  return ACCOUNTS.find((account) => account.username === normalized) || null;
}

function verifyPassword(account, password) {
  if (!account || typeof password !== 'string') return false;
  const expected = Buffer.from(account.hash, 'hex');
  const actual = crypto.scryptSync(password, account.salt, expected.length);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function publicUser(account) {
  return {
    username: account.username,
    displayName: account.displayName,
    orgs: [...account.orgs],
  };
}

module.exports = { ACCOUNTS, findAccount, verifyPassword, publicUser };
