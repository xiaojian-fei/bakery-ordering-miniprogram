'use strict';
const { ensure } = require('./errors');

// actor 是服务端适配层构造的可信身份，绝不能直接使用客户端 event.actor。
function requireActor(actor) {
  ensure(actor && typeof actor.openid === 'string' && actor.openid.trim().length > 0,
    'UNAUTHENTICATED', '需要可信的调用身份');
  ensure(['customer', 'staff', 'owner', 'system'].includes(actor.role), 'FORBIDDEN', '未知角色');
  if (actor.role === 'staff' || actor.role === 'owner') {
    ensure(actor.staffVerified === true, 'FORBIDDEN', '员工会话未经服务端验证');
  }
  if (actor.role === 'system') {
    ensure(actor.trustedSystem === true, 'FORBIDDEN', '系统身份未经验证');
  }
  return actor;
}

function requireCustomer(actor) {
  requireActor(actor);
  ensure(actor.role !== 'system', 'FORBIDDEN', '系统任务不能代顾客下单');
}

function requireOwner(actor, record) {
  requireCustomer(actor);
  ensure(record && record.ownerOpenid === actor.openid, 'FORBIDDEN', '只能操作本人的记录');
}

function requireRole(actor, allowed) {
  requireActor(actor);
  ensure(allowed.includes(actor.role), 'FORBIDDEN', '角色无权执行此操作');
}

module.exports = { requireActor, requireCustomer, requireOwner, requireRole };
