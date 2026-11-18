'use strict';
const { randomBytes, scrypt, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');
const { ensure } = require('./errors');
const derive = promisify(scrypt);
// OWASP列出的scrypt组合之一；固定参数也避免损坏记录触发任意成本计算。
const PARAMETERS = Object.freeze({ N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 });
const MIN_LENGTH = 12;
const CUSTOMER_MIN_LENGTH = 8;

// minLength 只允许在两组固定策略间选择：员工密码保持 12，顾客密码 8。
// 不允许调用方传入任意下限，避免出现比策略更弱的密码。
function requireLength(password, minLength) {
  ensure(minLength === MIN_LENGTH || minLength === CUSTOMER_MIN_LENGTH, 'INVALID_CONFIG', '密码长度策略不合法');
  ensure(typeof password === 'string' && password.length >= minLength && Buffer.byteLength(password, 'utf8') <= 128,
    'INVALID_PASSWORD', '密码至少' + minLength + '个字符，UTF-8编码不超过128字节');
}

async function hashPassword(password, { minLength = MIN_LENGTH } = {}) {
  requireLength(password, minLength);
  const salt = randomBytes(16).toString('hex');
  const key = await derive(password, salt, 32, PARAMETERS);
  return `scrypt$32768$8$3$${salt}$${key.toString('hex')}`;
}

async function verifyPassword(password, encoded) {
  if (typeof password !== 'string' || password.length === 0 || Buffer.byteLength(password, 'utf8') > 128
    || typeof encoded !== 'string') return false;
  const match = /^scrypt\$32768\$8\$3\$([0-9a-f]{32})\$([0-9a-f]{64})$/.exec(encoded);
  if (!match) return false;
  const actual = await derive(password, match[1], 32, PARAMETERS);
  return timingSafeEqual(actual, Buffer.from(match[2], 'hex'));
}

module.exports = { hashPassword, verifyPassword, MIN_LENGTH, CUSTOMER_MIN_LENGTH };