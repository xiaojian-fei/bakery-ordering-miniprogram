'use strict';
const { randomBytes, scrypt, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');
const { ensure } = require('./errors');
const derive = promisify(scrypt);
// OWASP列出的scrypt组合之一；固定参数也避免损坏记录触发任意成本计算。
const PARAMETERS = Object.freeze({ N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 });

async function hashPassword(password) {
  ensure(typeof password === 'string' && password.length >= 12 && Buffer.byteLength(password, 'utf8') <= 128,
    'INVALID_PASSWORD', '员工口令至少12个字符，UTF-8编码不超过128字节');
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

module.exports = { hashPassword, verifyPassword };
