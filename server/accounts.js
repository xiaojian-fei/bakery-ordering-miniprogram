'use strict';
const { randomBytes } = require('node:crypto');
const { ensure } = require('../core/domain/errors');
const { hashPassword, verifyPassword, MIN_LENGTH, CUSTOMER_MIN_LENGTH } = require('../core/domain/passwords');

const USERNAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{2,31}$/;
const STAFF_ROLES = ['staff', 'owner'];

function requireUsername(value) {
  ensure(typeof value === 'string' && USERNAME.test(value), 'INVALID_REQUEST', '用户名需为 3～32 位字母、数字或 _ . -');
  return value;
}

/**
 * 网页账号层：顾客注册登录、员工/店主登录、员工账号管理。
 *
 * 员工与店主的密码校验仍然交给既有的 StaffAuthService（scrypt + staff_sessions +
 * authVersion/passwordVersion 失效），这里只负责把“用户名密码登录”翻译成
 * “先解析可信 openid，再走员工会话”的既有流程。
 */
class Accounts {
  constructor({ repository, staffAuth, sessions, clock = Date.now, maxFailures = 5, lockMs = 15 * 60 * 1000 }) {
    if (!repository || typeof repository.transaction !== 'function') throw new Error('账号层需要事务适配器');
    Object.assign(this, { repository, staffAuth, sessions, clock, maxFailures, lockMs });
  }

  async findByUsername(username) {
    return this.repository.transaction(async tx => {
      const rows = await tx.query('users', {
        filters: [{ field: 'username', value: username }],
        orderBy: [{ field: '_id', direction: 'asc' }], limit: 1
      });
      return rows[0] || null;
    });
  }

  async register({ username, password }) {
    requireUsername(username);
    const openid = 'cus-' + randomBytes(10).toString('hex');
    const passwordHash = await hashPassword(password, { minLength: CUSTOMER_MIN_LENGTH });
    const now = this.clock();
    await this.repository.transaction(async tx => {
      const clash = await tx.query('users', {
        filters: [{ field: 'username', value: username }], orderBy: [{ field: '_id', direction: 'asc' }], limit: 1
      });
      ensure(clash.length === 0, 'USERNAME_TAKEN', '该用户名已被占用');
      await tx.set('users', openid, {
        openid, role: 'customer', active: true, authVersion: 0, username, createdAt: now
      });
      await tx.set('customer_credentials', openid, {
        openid, passwordHash, passwordVersion: 1, failedAttempts: 0, lockedUntil: 0, createdAt: now
      });
      await tx.set('auth_events', 'web-register-' + openid, {
        openid, action: 'CUSTOMER_REGISTERED', createdAt: now
      });
    });
    return { openid, username, role: 'customer' };
  }

  /** 顾客密码校验：失败计数与锁定放在事务内提交，判定结果在事务外抛出。 */
  async verifyCustomer(user, password) {
    const initial = await this.repository.transaction(tx => tx.get('customer_credentials', user.openid));
    ensure(initial && Number.isSafeInteger(initial.passwordVersion), 'AUTH_FAILED', '用户名或密码不正确');
    const now = this.clock();
    ensure(!(initial.lockedUntil > now), 'AUTH_LOCKED', '登录失败次数过多，请稍后重试');
    const correct = await verifyPassword(password, initial.passwordHash);
    await this.repository.transaction(async tx => {
      const credential = await tx.get('customer_credentials', user.openid);
      ensure(credential && credential.passwordHash === initial.passwordHash, 'AUTH_RETRY', '账号配置已变化，请重新登录');
      const failures = credential.lockedUntil && credential.lockedUntil <= now ? 0 : (credential.failedAttempts || 0);
      if (correct) {
        await tx.set('customer_credentials', user.openid, {
          ...credential, failedAttempts: 0, lockedUntil: 0, updatedAt: now
        });
      } else {
        const attempts = failures + 1;
        await tx.set('customer_credentials', user.openid, {
          ...credential, failedAttempts: attempts,
          lockedUntil: attempts >= this.maxFailures ? now + this.lockMs : 0, updatedAt: now
        });
      }
    });
    ensure(correct, 'AUTH_FAILED', '用户名或密码不正确');
  }

  /**
   * 统一登录入口：顾客校验顾客凭据；员工与店主校验员工凭据并签发员工会话。
   * 返回的 staffToken 由 HTTP 层写入 HttpOnly Cookie，不回到页面脚本。
   */
  async login({ username, password, userAgent = '' }) {
    requireUsername(username);
    ensure(typeof password === 'string' && password.length > 0 && Buffer.byteLength(password, 'utf8') <= 128,
      'AUTH_FAILED', '用户名或密码不正确');
    const user = await this.findByUsername(username);
    ensure(user && user.active === true, 'AUTH_FAILED', '用户名或密码不正确');
    if (!STAFF_ROLES.includes(user.role)) {
      await this.verifyCustomer(user, password);
      const session = await this.sessions.create(user.openid, { userAgent });
      return { openid: user.openid, username: user.username, role: user.role,
        session, staffToken: null, staffExpiresAt: null };
    }
    const staff = await this.staffAuth.login(user.openid, password);
    const session = await this.sessions.create(user.openid, { userAgent });
    return { openid: user.openid, username: user.username, role: user.role,
      session, staffToken: staff.token, staffExpiresAt: staff.expiresAt };
  }

  async logout({ token, staffToken, openid }) {
    const revoked = await this.sessions.revoke(token);
    let staffRevoked = false;
    if (typeof staffToken === 'string' && openid) {
      try {
        const result = await this.staffAuth.logout(openid, staffToken);
        staffRevoked = result?.revoked === true;
      } catch (_) { /* 令牌已过期或已注销时无需额外处理 */ }
    }
    return { revoked, staffRevoked };
  }

  /**
   * 自助修改密码。
   *
   * 顺序是"先验旧密码、再校验新密码强度"，避免未登录者用长度报错探测密码策略。
   * 员工与店主的密码版本会 +1，既有的员工会话随之全部失效，因此必须重新登录；
   * 顾客改密码后保留当前会话，其它设备上的会话全部撤销。
   */
  async changePassword({ openid, currentPassword, newPassword, keepToken = null }) {
    if (typeof openid !== 'string' || openid.length === 0) throw new Error('INVALID_IDENTITY');
    ensure(typeof currentPassword === 'string' && currentPassword.length > 0
      && Buffer.byteLength(currentPassword, 'utf8') <= 128, 'AUTH_FAILED', '当前密码不正确');
    ensure(typeof newPassword === 'string' && newPassword.length > 0, 'INVALID_REQUEST', '新密码不能为空');
    ensure(currentPassword !== newPassword, 'INVALID_PASSWORD', '新密码不能与当前密码相同');

    const now = this.clock();
    const user = await this.repository.transaction(tx => tx.get('users', openid));
    ensure(user && user.active === true, 'UNAUTHENTICATED', '账号不可用');
    const staffAccount = STAFF_ROLES.includes(user.role);
    const table = staffAccount ? 'staff_credentials' : 'customer_credentials';

    // 1) 校验当前密码（沿用在线的锁定策略）
    const initial = await this.repository.transaction(tx => tx.get(table, openid));
    ensure(initial && typeof initial.passwordHash === 'string' && Number.isSafeInteger(initial.passwordVersion),
      'AUTH_FAILED', '当前密码不正确');
    ensure(!(initial.lockedUntil > now), 'AUTH_LOCKED', '失败次数过多，请稍后再试');
    const correct = await verifyPassword(currentPassword, initial.passwordHash);
    ensure(correct, 'AUTH_FAILED', '当前密码不正确');

    // 2) 校验并计算新密码哈希（员工 12 位、顾客 8 位下限）
    const passwordHash = await hashPassword(newPassword, {
      minLength: staffAccount ? MIN_LENGTH : CUSTOMER_MIN_LENGTH
    });

    // 3) 写入新哈希并升版本；提交前重新确认凭据没被别人改过
    await this.repository.transaction(async tx => {
      const credential = await tx.get(table, openid);
      ensure(credential && credential.passwordHash === initial.passwordHash,
        'AUTH_RETRY', '账号配置已变化，请重新操作');
      await tx.set(table, openid, {
        ...credential,
        passwordHash,
        passwordVersion: credential.passwordVersion + 1,
        failedAttempts: 0,
        lockedUntil: 0,
        updatedAt: now
      });
      await tx.set('auth_events', 'pwd-self-' + randomBytes(8).toString('hex'), {
        openid, action: 'PASSWORD_CHANGED_SELF', role: user.role, createdAt: now
      });
    });

    // 4) 会话处理：员工必须重新登录；顾客保留当前会话、撤销其它设备
    const revokedSessions = await this.sessions.revokeAllFor(openid, {
      keepToken: staffAccount ? null : keepToken
    });
    return { changed: true, reauthRequired: staffAccount, revokedSessions };
  }

  /** 店主创建员工账号：先建普通用户，再用既有授权与设密服务提升。 */
  async createStaff(ownerActor, { username, password }) {
    requireUsername(username);
    ensure(typeof password === 'string', 'INVALID_REQUEST', '密码不能为空');
    const openid = 'stf-' + randomBytes(10).toString('hex');
    const now = this.clock();
    await this.repository.transaction(async tx => {
      const clash = await tx.query('users', {
        filters: [{ field: 'username', value: username }], orderBy: [{ field: '_id', direction: 'asc' }], limit: 1
      });
      ensure(clash.length === 0, 'USERNAME_TAKEN', '该用户名已被占用');
      await tx.set('users', openid, {
        openid, role: 'customer', active: true, authVersion: 0, username, createdAt: now
      });
    });
    await this.staffAuth.setStaffAccess(ownerActor, openid, true);
    await this.staffAuth.setPassword(ownerActor, openid, password);
    return { openid, username, role: 'staff' };
  }

  async listStaff() {
    const rows = await this.repository.transaction(tx => tx.query('users', {
      filters: [{ field: 'role', op: 'in', value: ['staff', 'owner'] }],
      orderBy: [{ field: 'createdAt', direction: 'asc' }], limit: 100
    }));
    return rows.map(user => ({
      openid: user.openid, username: user.username || '', role: user.role,
      active: user.active === true, createdAt: user.createdAt
    }));
  }

  async setStaffAccess(ownerActor, { username, enabled }) {
    requireUsername(username);
    const user = await this.findByUsername(username);
    ensure(user && STAFF_ROLES.includes(user.role), 'INVALID_STAFF', '找不到该员工账号');
    return this.staffAuth.setStaffAccess(ownerActor, user.openid, enabled === true);
  }

  /** 仅供 HTTP 层把员工令牌解析成可信 actor；未通过校验时抛出。 */
  async resolveStaffActor(openid, staffToken) {
    return this.staffAuth.resolveActor(openid, staffToken);
  }
}

module.exports = { Accounts, USERNAME };