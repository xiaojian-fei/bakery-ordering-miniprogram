'use strict';
const { ensure } = require('../domain/errors');
const { requireIdentity } = require('../domain/staff-auth-service');
const { hashPassword } = require('../domain/passwords');

const MARKER_ID = 'first-owner-v1';

// 仅供部署管理员在全新环境中调用；不注册到application客户端动作。
// 角色集合需由部署侧保护。该方法不扫描或接管已有环境中的其他店主。
class OwnerBootstrap {
  constructor(repository, { clock = Date.now } = {}) {
    ensure(repository && typeof repository.transaction === 'function' && typeof clock === 'function',
      'INVALID_CONFIG', '初始化需要事务适配器与时钟');
    this.repository = repository;
    this.clock = clock;
  }

  async initialize({ ownerOpenid, password } = {}) {
    requireIdentity(ownerOpenid);
    const passwordHash = await hashPassword(password);
    return this.repository.transaction(async tx => {
      const marker = await tx.get('system_settings', MARKER_ID);
      const user = await tx.get('users', ownerOpenid);
      const credential = await tx.get('staff_credentials', ownerOpenid);
      if (marker) {
        ensure(marker.ownerOpenid === ownerOpenid, 'BOOTSTRAP_CONFLICT', '环境已经绑定其他初始店主');
        ensure(marker.schemaVersion === 1 && user?.openid === ownerOpenid
          && user.role === 'owner' && user.active === true && Number.isSafeInteger(user.authVersion)
          && user.authVersion >= 0 && Number.isSafeInteger(credential?.passwordVersion)
          && credential.passwordVersion >= 1 && typeof credential.passwordHash === 'string'
          && /^scrypt\$32768\$8\$3\$[0-9a-f]{32}\$[0-9a-f]{64}$/.test(credential.passwordHash),
        'BOOTSTRAP_INCONSISTENT', '初始化标记与账号不一致，需部署管理员核对');
        // 重试不是重设口令；不返回或替换原有哈希。
        return { initialized: true, changed: false };
      }
      ensure(!user && !credential, 'BOOTSTRAP_CONFLICT', '目标账号已有数据，不能自动覆盖或提升权限');
      const now = this.clock();
      ensure(Number.isSafeInteger(now) && now >= 0, 'INVALID_CONFIG', '初始化时间不合法');
      await tx.set('users', ownerOpenid, { openid: ownerOpenid, role: 'owner', active: true,
        authVersion: 0, createdAt: now });
      await tx.set('staff_credentials', ownerOpenid, { passwordHash, passwordVersion: 1,
        failedAttempts: 0, lockedUntil: 0, createdAt: now });
      await tx.set('system_settings', MARKER_ID, { schemaVersion: 1, ownerOpenid, initializedAt: now });
      await tx.set('auth_events', 'owner-bootstrap-v1', { openid: ownerOpenid,
        action: 'OWNER_BOOTSTRAPPED', createdAt: now });
      return { initialized: true, changed: true };
    });
  }
}

module.exports = { OwnerBootstrap };
