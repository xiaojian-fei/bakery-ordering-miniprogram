'use strict';
const { hashPassword } = require('../../cloudfunctions/api/domain/passwords');
const { StaffAuthService } = require('../../cloudfunctions/api/domain/staff-auth-service');
const { MemoryRepository } = require('./memory-repository');

// 仅测试口令，真实部署必须自行初始化，不存在默认生产账号或口令。
const DEMO_PASSWORD = 'DemoOnly-Local-Test-2026';
const initialHash = hashPassword(DEMO_PASSWORD);

async function authFixture(options = {}) {
  let now = 1000000;
  const passwordHash = await initialHash;
  const repository = new MemoryRepository({
    users: {
      'owner-demo': { openid: 'owner-demo', role: 'owner', active: true, authVersion: 0 },
      'staff-demo': { openid: 'staff-demo', role: 'staff', active: true, authVersion: 0 }
    },
    staff_credentials: Object.fromEntries(['owner-demo', 'staff-demo'].map(openid => [openid,
      { passwordHash, passwordVersion: 1, failedAttempts: 0, lockedUntil: 0 }])),
    products: { bread: { _id: 'bread', name: '演示商品', priceCents: 1250,
      isOnSale: true, onHand: 10, reserved: 0, inventoryVersion: 0 } }
  });
  const clock = () => now;
  return { repository, clock, auth: new StaffAuthService(repository, { clock, ...options }),
    setTime: value => { now = value; } };
}

module.exports = { authFixture, DEMO_PASSWORD };
