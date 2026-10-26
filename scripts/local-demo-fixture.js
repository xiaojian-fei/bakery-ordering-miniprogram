'use strict';
const { randomBytes } = require('node:crypto');
const { OwnerBootstrap } = require('../cloudfunctions/api/setup/owner-bootstrap');
const { StaffAuthService } = require('../cloudfunctions/api/domain/staff-auth-service');
const { createApplication } = require('../cloudfunctions/api/application');
const { createTradeClient } = require('../services/trade-client');
const { MemoryRepository } = require('../test/support/memory-repository');

// 仅本地演示夹具：角色可切换、员工测试口令自动填充，不是生产身份适配器。
async function createLocalDemo() {
  let now = Date.now();
  const clock = () => now;
  const password = randomBytes(24).toString('hex');
  const repository = new MemoryRepository({ products: {
    bread: { _id: 'bread', name: '莓果司康', desc: '虚构演示商品', category: '司康', priceCents: 1250,
      onHand: 30, reserved: 0, inventoryVersion: 0, catalogVersion: 0, isOnSale: true },
    cookie: { _id: 'cookie', name: '黄油饼干', desc: '虚构演示商品', category: '饼干', priceCents: 500,
      onHand: 50, reserved: 0, inventoryVersion: 0, catalogVersion: 0, isOnSale: true }
  } });
  await new OwnerBootstrap(repository, { clock }).initialize({ ownerOpenid: 'owner-demo', password });
  const auth = new StaffAuthService(repository, { clock });
  const ownerActor = { openid: 'owner-demo', role: 'owner', staffVerified: true };
  await auth.setStaffAccess(ownerActor, 'staff-demo', true);
  await auth.setPassword(ownerActor, 'staff-demo', password);
  const identities = { buyer: 'buyer-demo', staff: 'staff-demo', owner: 'owner-demo' };
  const application = createApplication({ repository, clock, resolveIdentity: async context => ({ openid: context.demoSubject }) });
  async function handle(request, identity) {
    if (!Object.hasOwn(identities, identity)) return { success: false, error: { code: 'UNAUTHENTICATED', message: '未知演示身份' } };
    // 此替换只存在于演示夹具，生产适配绝不能跳过真实员工口令。
    const envelope = request.action === 'staff.login' ? { ...request, data: { password } } : request;
    return application.handle(envelope, { demoSubject: identities[identity] });
  }
  async function client(identity) {
    const value = createTradeClient({ clock, send: request => handle(request, identity) });
    if (identity !== 'buyer') await value.staff.login('LOCAL_DEMO_ONLY');
    return value;
  }
  return { repository, application, clock, handle, client,
    advance: milliseconds => { now += milliseconds; return now; } };
}
module.exports = { createLocalDemo };
