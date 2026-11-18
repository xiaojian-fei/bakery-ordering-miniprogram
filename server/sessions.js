'use strict';
const { createHash, randomBytes } = require('node:crypto');

const digest = value => createHash('sha256').update(value).digest('hex');
const TOKEN = /^[0-9a-f]{64}$/;

function parseCookies(header) {
  const cookies = {};
  if (typeof header !== 'string' || header.length === 0) return cookies;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    let value = part.slice(index + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try { cookies[name] = decodeURIComponent(value); } catch (_) { /* 忽略畸形 Cookie */ }
  }
  return cookies;
}

function serializeCookie(name, value, { maxAge, secure, path = '/', sameSite = 'Strict' } = {}) {
  const parts = [`${name}=${value}`, `Path=${path}`, 'HttpOnly', `SameSite=${sameSite}`];
  if (Number.isInteger(maxAge)) parts.push(`Max-Age=${maxAge}`);
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/**
 * 网页会话：只把 sha256(令牌) 存进数据库，Cookie 里放原文。
 * 数据库泄露或备份外流都拿不到可用的会话令牌。
 */
class SessionStore {
  constructor({ repository, clock = Date.now, ttlMs, cookieName, staffCookieName, secure = false }) {
    if (!repository || typeof repository.transaction !== 'function') throw new Error('会话需要事务适配器');
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error('会话有效期不合法');
    Object.assign(this, { repository, clock, ttlMs, cookieName, staffCookieName, secure });
  }

  async create(openid, { userAgent = '' } = {}) {
    const token = randomBytes(32).toString('hex');
    const now = this.clock();
    const expiresAt = now + this.ttlMs;
    await this.repository.transaction(tx => tx.set('web_sessions', digest(token), {
      openid, createdAt: now, expiresAt, revokedAt: null,
      userAgentHash: digest(userAgent || 'unknown').slice(0, 16)
    }));
    return { token, expiresAt };
  }

  async resolve(token) {
    if (typeof token !== 'string' || !TOKEN.test(token)) return null;
    const record = await this.repository.transaction(tx => tx.get('web_sessions', digest(token)));
    if (!record || record.revokedAt !== null) return null;
    if (!(record.expiresAt > this.clock())) return null;
    return { openid: record.openid, expiresAt: record.expiresAt };
  }

  async revoke(token) {
    if (typeof token !== 'string' || !TOKEN.test(token)) return false;
    return this.repository.transaction(async tx => {
      const id = digest(token);
      const record = await tx.get('web_sessions', id);
      if (!record || record.revokedAt !== null) return false;
      await tx.set('web_sessions', id, { ...record, revokedAt: this.clock() });
      return true;
    });
  }

  /**
   * 撤销某账号的全部网页会话。keepToken 有值时保留该会话（顾客改密码后继续用当前会话）。
   * 修改密码后调用，保证其它设备上的登录立即失效。
   */
  async revokeAllFor(openid, { keepToken = null } = {}) {
    if (typeof openid !== 'string' || openid.length === 0) return 0;
    const keepId = typeof keepToken === 'string' && TOKEN.test(keepToken) ? digest(keepToken) : null;
    return this.repository.transaction(async tx => {
      const rows = await tx.query('web_sessions', {
        filters: [{ field: 'openid', value: openid }],
        orderBy: [{ field: 'createdAt', direction: 'asc' }], limit: 100
      });
      let revoked = 0;
      for (const row of rows) {
        if (row.revokedAt !== null) continue;
        if (keepId && row._id === keepId) continue;
        await tx.set('web_sessions', row._id, { ...row, revokedAt: this.clock() });
        revoked += 1;
      }
      return revoked;
    });
  }

  async purgeExpired({ limit = 200 } = {}) {
    return this.repository.transaction(async tx => {
      const now = this.clock();
      const rows = await tx.query('web_sessions', {
        filters: [{ field: 'expiresAt', op: 'lte', value: now }],
        orderBy: [{ field: 'expiresAt', direction: 'asc' }], limit
      });
      for (const row of rows) await tx.set('web_sessions', row._id, { ...row, revokedAt: row.revokedAt ?? now });
      return rows.length;
    });
  }

  cookie(token, expiresAt) {
    return serializeCookie(this.cookieName, token, {
      maxAge: Math.max(1, Math.floor((expiresAt - this.clock()) / 1000)), secure: this.secure
    });
  }

  clearCookie() {
    return serializeCookie(this.cookieName, '', { maxAge: 0, secure: this.secure });
  }

  // 员工令牌同样只走 HttpOnly Cookie，页面脚本读不到令牌原文。
  staffCookie(token, expiresAt) {
    return serializeCookie(this.staffCookieName, token, {
      maxAge: Math.max(1, Math.floor((expiresAt - this.clock()) / 1000)), secure: this.secure
    });
  }

  clearStaffCookie() {
    return serializeCookie(this.staffCookieName, '', { maxAge: 0, secure: this.secure });
  }
}

module.exports = { SessionStore, parseCookies, serializeCookie, digest, TOKEN };