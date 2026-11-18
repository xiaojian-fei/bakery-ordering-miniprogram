'use strict';
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { ensure } = require('./errors');
const { requireRole } = require('./auth');
const { hashPassword, verifyPassword } = require('./passwords');

const digest = value => createHash('sha256').update(value).digest('hex');
const staffRoles = ['staff', 'owner'];
function requireIdentity(openid) {
  ensure(typeof openid === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(openid),
    'UNAUTHENTICATED', '缺少可信的服务端身份');
}
function enabledStaff(user, credential) {
  return user && user.active === true && staffRoles.includes(user.role)
    && Number.isSafeInteger(user.authVersion) && user.authVersion >= 0
    && credential && Number.isSafeInteger(credential.passwordVersion) && credential.passwordVersion >= 1;
}

class StaffAuthService {
  constructor(repository, { clock = Date.now, sessionTtlMs = 2 * 60 * 60 * 1000,
    maxFailures = 5, lockMs = 15 * 60 * 1000 } = {}) {
    ensure(repository && typeof repository.transaction === 'function', 'INVALID_CONFIG', '缺少事务适配器');
    for (const value of [sessionTtlMs, maxFailures, lockMs]) {
      ensure(Number.isSafeInteger(value) && value > 0, 'INVALID_CONFIG', '认证策略不合法');
    }
    this.repository = repository;
    this.clock = clock;
    this.sessionTtlMs = sessionTtlMs;
    this.maxFailures = maxFailures;
    this.lockMs = lockMs;
  }

  // openid由传输适配器验证，不能取自登录表单中的身份/角色字段。
  async login(openid, password) {
    requireIdentity(openid);
    ensure(typeof password === 'string' && password.length > 0 && Buffer.byteLength(password, 'utf8') <= 128,
      'AUTH_FAILED', '身份或口令不正确');
    const initial = await this.repository.transaction(async tx => ({
      user: await tx.get('users', openid), credential: await tx.get('staff_credentials', openid)
    }));
    ensure(enabledStaff(initial.user, initial.credential), 'AUTH_FAILED', '身份或口令不正确');
    ensure(!(initial.credential.lockedUntil > this.clock()), 'AUTH_LOCKED', '登录失败次数过多，请稍后重试');
    // 较昂贵的口令计算放在事务外；提交前必须重新检查账号和口令版本。
    const correct = await verifyPassword(password, initial.credential.passwordHash);
    const token = randomBytes(32).toString('hex');
    const sessionId = digest(token);
    const auditId = randomUUID();
    const result = await this.repository.transaction(async tx => {
      const user = await tx.get('users', openid);
      const credential = await tx.get('staff_credentials', openid);
      ensure(enabledStaff(user, credential), 'AUTH_FAILED', '身份或口令不正确');
      ensure(user.authVersion === initial.user.authVersion && user.role === initial.user.role
        && credential.passwordVersion === initial.credential.passwordVersion
        && credential.passwordHash === initial.credential.passwordHash,
      'AUTH_RETRY', '账号配置已变化，请重新登录');
      const now = this.clock();
      ensure(!(credential.lockedUntil > now), 'AUTH_LOCKED', '登录失败次数过多，请稍后重试');
      const previousFailures = credential.lockedUntil && credential.lockedUntil <= now
        ? 0 : (credential.failedAttempts || 0);
      if (!correct) {
        credential.failedAttempts = previousFailures + 1;
        credential.lockedUntil = credential.failedAttempts >= this.maxFailures ? now + this.lockMs : 0;
        await tx.set('staff_credentials', openid, credential);
        await tx.set('auth_events', auditId, { openid, action: 'LOGIN_FAILED', createdAt: now,
          locked: credential.lockedUntil > now });
        // 错误在事务提交后抛出，避免失败次数随回滚丢失。
        return { errorCode: credential.lockedUntil > now ? 'AUTH_LOCKED' : 'AUTH_FAILED' };
      }
      credential.failedAttempts = 0;
      credential.lockedUntil = 0;
      const expiresAt = now + this.sessionTtlMs;
      await tx.set('staff_credentials', openid, credential);
      await tx.set('staff_sessions', sessionId, { openid, role: user.role,
        authVersion: user.authVersion, passwordVersion: credential.passwordVersion,
        createdAt: now, expiresAt, revokedAt: null });
      await tx.set('auth_events', auditId, { openid, action: 'LOGIN_SUCCEEDED', createdAt: now });
      return { token, role: user.role, expiresAt };
    });
    ensure(!result.errorCode, result.errorCode, result.errorCode === 'AUTH_LOCKED'
      ? '登录失败次数过多，请稍后重试' : '身份或口令不正确');
    return result;
  }

  async resolveActor(openid, token) {
    requireIdentity(openid);
    if (token === undefined) {
      const user = await this.repository.transaction(tx => tx.get('users', openid));
      ensure(!user || user.active !== false, 'ACCOUNT_DISABLED', '账号已停用');
      // 员工未完成二次认证时仍可作为普通顾客购买自己的订单。
      return { openid, role: 'customer' };
    }
    ensure(typeof token === 'string' && /^[0-9a-f]{64}$/.test(token), 'UNAUTHENTICATED', '员工会话无效');
    return this.repository.transaction(async tx => {
      const session = await tx.get('staff_sessions', digest(token));
      const user = await tx.get('users', openid);
      const credential = await tx.get('staff_credentials', openid);
      ensure(enabledStaff(user, credential) && session && session.openid === openid
        && session.revokedAt === null && session.expiresAt > this.clock()
        && session.role === user.role && session.authVersion === user.authVersion
        && session.passwordVersion === credential.passwordVersion,
      'UNAUTHENTICATED', '员工会话已失效，请重新登录');
      return { openid, role: user.role, staffVerified: true };
    });
  }

  async logout(openid, token) {
    requireIdentity(openid);
    ensure(typeof token === 'string' && /^[0-9a-f]{64}$/.test(token), 'UNAUTHENTICATED', '员工会话无效');
    return this.repository.transaction(async tx => {
      const id = digest(token);
      const session = await tx.get('staff_sessions', id);
      if (!session) return { revoked: true };
      ensure(session.openid === openid, 'UNAUTHENTICATED', '员工会话无效');
      if (session.revokedAt === null) {
        session.revokedAt = this.clock();
        await tx.set('staff_sessions', id, session);
      }
      return { revoked: true };
    });
  }

  async setPassword(actor, targetOpenid, password) {
    requireRole(actor, ['owner']);
    requireIdentity(targetOpenid);
    const passwordHash = await hashPassword(password);
    const auditId = randomUUID();
    return this.repository.transaction(async tx => {
      const user = await tx.get('users', targetOpenid);
      const previous = await tx.get('staff_credentials', targetOpenid);
      ensure(user && user.active === true && staffRoles.includes(user.role), 'INVALID_STAFF', '目标不是启用的员工账号');
      const passwordVersion = (previous?.passwordVersion || 0) + 1;
      ensure(Number.isSafeInteger(passwordVersion) && passwordVersion >= 1, 'INVALID_STAFF', '口令版本不合法');
      await tx.set('staff_credentials', targetOpenid, { passwordHash, passwordVersion,
        failedAttempts: 0, lockedUntil: 0, updatedAt: this.clock() });
      await tx.set('auth_events', auditId, { openid: targetOpenid, action: 'PASSWORD_CHANGED',
        operatorOpenid: actor.openid, createdAt: this.clock() });
      return { changed: true };
    });
  }

  async setStaffAccess(actor, targetOpenid, enabled) {
    requireRole(actor, ['owner']);
    requireIdentity(targetOpenid);
    ensure(typeof enabled === 'boolean', 'INVALID_REQUEST', '员工授权状态必须是布尔值');
    const auditId = randomUUID();
    return this.repository.transaction(async tx => {
      const previous = await tx.get('users', targetOpenid);
      // 单店首版的店主由部署初始化，普通管理入口不创建/降级店主。
      ensure(targetOpenid !== actor.openid && previous?.role !== 'owner',
        'OWNER_ACCOUNT_PROTECTED', '不能通过员工授权入口修改店主身份');
      const role = enabled ? 'staff' : 'customer';
      ensure(!previous || previous.active !== false, 'ACCOUNT_DISABLED', '目标账号已停用');
      if (previous?.role === role) return { role, changed: false };
      const authVersion = (previous?.authVersion ?? 0) + 1;
      ensure(Number.isSafeInteger(authVersion) && authVersion >= 1, 'INVALID_STAFF', '授权版本不合法');
      await tx.set('users', targetOpenid, { ...(previous || {}), openid: targetOpenid,
        role, active: true, authVersion, updatedAt: this.clock() });
      await tx.set('auth_events', auditId, { openid: targetOpenid,
        action: enabled ? 'STAFF_GRANTED' : 'STAFF_REVOKED', operatorOpenid: actor.openid,
        createdAt: this.clock() });
      return { role, changed: true };
    });
  }
}

module.exports = { StaffAuthService, requireIdentity };
