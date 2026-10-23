'use strict';
const { BusinessError, ensure } = require('./domain/errors');
const { StaffAuthService, requireIdentity } = require('./domain/staff-auth-service');
const { OrderService } = require('./domain/order-service');
const { InventoryService } = require('./domain/inventory-service');
const { RefundService } = require('./domain/refund-service');

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// 仅业务入口工厂，不是云函数/HTTP服务器。resolveIdentity必须由可信传输适配器注入。
function createApplication({ repository, resolveIdentity, clock, shipping } = {}) {
  ensure(typeof resolveIdentity === 'function', 'INVALID_CONFIG', '必须注入服务端身份解析器');
  const auth = new StaffAuthService(repository, { clock });
  const orders = new OrderService(repository, { clock, shipping });
  const inventory = new InventoryService(repository, { clock });
  const refunds = new RefundService(repository, { clock });
  const routes = new Map([
    ['identity.me', actor => actor],
    ['orders.quote', (actor, data) => orders.quote(actor, data)],
    ['orders.create', (actor, data) => orders.create(actor, data)],
    ['orders.get', (actor, data) => orders.get(actor, data.orderId)],
    ['orders.pay', (actor, data) => orders.simulatePay(actor, data.orderId,
      Object.fromEntries(['outcome', 'success', 'attemptId', 'reasonCode', 'expectedVersion']
        .filter(key => Object.hasOwn(data, key)).map(key => [key, data[key]])))],
    ['orders.cancel', (actor, data) => orders.cancel(actor, data.orderId, { expectedVersion: data.expectedVersion })],
    ['orders.reject', (actor, data) => refunds.rejectOrder(actor, data)],
    ['inventory.adjust', (actor, data) => inventory.adjust(actor, data)],
    ['refunds.executeApproved', (actor, data) => refunds.refundApproved(actor, data.afterSaleId,
      { expectedOrderVersion: data.expectedOrderVersion })],
    ['staff.setPassword', (actor, data) => auth.setPassword(actor, data.targetOpenid, data.password)],
    ['staff.setAccess', (actor, data) => auth.setStaffAccess(actor, data.targetOpenid, data.enabled)]
  ]);

  async function handle(request, trustedTransportContext) {
    try {
      ensure(object(request) && typeof request.action === 'string', 'INVALID_REQUEST', '请求格式不合法');
      const data = request.data === undefined ? {} : request.data;
      ensure(object(data), 'INVALID_REQUEST', '请求数据必须是对象');
      ensure(routes.has(request.action) || ['staff.login', 'staff.logout'].includes(request.action),
        'INVALID_ACTION', '未开放此业务操作');
      // 不向解析器传request，且不信任request/data中的openid、role、actor或系统标记。
      const identity = await resolveIdentity(trustedTransportContext);
      requireIdentity(identity?.openid);
      let result;
      if (request.action === 'staff.login') result = await auth.login(identity.openid, data.password);
      else if (request.action === 'staff.logout') result = await auth.logout(identity.openid, request.staffToken);
      else {
        const actor = await auth.resolveActor(identity.openid, request.staffToken);
        result = await routes.get(request.action)(actor, data);
      }
      return { success: true, data: result };
    } catch (error) {
      return { success: false, error: error instanceof BusinessError
        ? { code: error.code, message: error.message }
        : { code: 'INTERNAL_ERROR', message: '服务暂不可用，请稍后重试' } };
    }
  }

  // 仅给已验证的后台调度器接入，不出现在客户端action路由中。
  const expireOrder = orderId => orders.expire({ openid: 'scheduled-order-expiry', role: 'system', trustedSystem: true }, orderId);
  return { handle, expireOrder };
}

module.exports = { createApplication };
