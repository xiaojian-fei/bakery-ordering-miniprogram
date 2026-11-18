'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { TradeApiError } = require('../shared/trade-errors');
const { createOperationRecovery } = require('../shared/operation-recovery');

/** 平台无关的内存存储：接口与 web/storage.js 的 localStorage 实现一致。 */
function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  const calls = { get: 0, set: 0, remove: 0 };
  return {
    data,
    calls,
    async get(key) { calls.get += 1; return data.get(key); },
    async set(key, value) { calls.set += 1; data.set(key, JSON.parse(JSON.stringify(value))); },
    async remove(key) { calls.remove += 1; data.delete(key); }
  };
}

function harness({ subjectId = 'buyer-1', storage = memoryStorage(), send, validResult } = {}) {
  const runtime = {
    checkoutNamespace: 'bakery.checkout.v1',
    subjectId,
    sessionChanged: false,
    async assertIdentity() {
      if (this.sessionChanged) throw new TradeApiError('SESSION_CHANGED');
    }
  };
  const sent = [];
  const recovery = createOperationRecovery({
    runtime,
    storage,
    scope: 'fulfillment',
    // 与真实模块一致：输入与存储记录都是 { action, payload }，normalize 必须幂等
    normalize: input => ({ action: input.action, payload: { orderId: input.payload.orderId } }),
    send: async command => {
      sent.push(command);
      if (send) return send(command);
      return { orderId: command.payload.orderId, ok: true };
    },
    validResult: validResult || ((command, result) => result?.ok === true),
    errors: {
      invalid: 'INVALID_FULFILLMENT_RECORD',
      storage: 'FULFILLMENT_STORAGE_ERROR',
      pending: 'FULFILLMENT_RECOVERY_REQUIRED'
    }
  });
  return { recovery, runtime, storage, sent };
}

test('恢复协议：prepare 写入记录，inspect 读回规范化命令', async () => {
  const { recovery, storage } = harness();
  const prepared = await recovery.prepare({ action: 'accept', payload: { orderId: 'ord_1', extra: '被丢弃' } });
  assert.deepEqual(prepared, { action: 'accept', payload: { orderId: 'ord_1' } });
  assert.equal(storage.calls.set, 1);
  const record = storage.data.get('bakery.checkout.v1:fulfillment:buyer-1');
  assert.equal(record.schema, 1);
  assert.equal(record.subjectId, 'buyer-1');
  assert.deepEqual(await recovery.inspect(), prepared);
});

test('恢复协议：存在未确认记录时拒绝新的 prepare', async () => {
  const { recovery } = harness();
  await recovery.prepare({ action: 'accept', payload: { orderId: 'ord_1' } });
  await assert.rejects(recovery.prepare({ action: 'accept', payload: { orderId: 'ord_2' } }),
    (error) => error instanceof TradeApiError && error.code === 'FULFILLMENT_RECOVERY_REQUIRED');
});

test('恢复协议：提交成功后清除记录并返回结果', async () => {
  const { recovery, storage, sent } = harness();
  await recovery.prepare({ action: 'accept', payload: { orderId: 'ord_1' } });
  const { result, storageWarning } = await recovery.submit();
  assert.equal(result.ok, true);
  assert.equal(storageWarning, false);
  assert.equal(sent.length, 1);
  assert.equal(storage.data.size, 0, '成功提交必须清除草稿');
  assert.equal(await recovery.inspect(), null);
});

test('恢复协议：结果不明（网络中断）时保留记录，可后续重试', async () => {
  const { recovery, storage } = harness({
    send: async () => { throw new TradeApiError('NETWORK_ERROR', { uncertain: true }); }
  });
  await recovery.prepare({ action: 'accept', payload: { orderId: 'ord_1' } });
  await assert.rejects(recovery.submit(),
    (error) => error.code === 'NETWORK_ERROR' && error.uncertain === true);
  assert.equal(storage.data.size, 1, '结果未知时不能丢弃原请求');
});

test('恢复协议：明确的业务失败清除记录，避免卡住后续操作', async () => {
  const { recovery, storage } = harness({
    send: async () => { throw new TradeApiError('VERSION_CONFLICT'); }
  });
  await recovery.prepare({ action: 'accept', payload: { orderId: 'ord_1' } });
  await assert.rejects(recovery.submit(), (error) => error.code === 'VERSION_CONFLICT');
  assert.equal(storage.data.size, 0);
});

test('恢复协议：身份丢失类错误保留记录，登录后仍可重试', async () => {
  const { recovery, storage } = harness({
    send: async () => { throw new TradeApiError('UNAUTHENTICATED'); }
  });
  await recovery.prepare({ action: 'accept', payload: { orderId: 'ord_1' } });
  await assert.rejects(recovery.submit(), (error) => error.code === 'UNAUTHENTICATED');
  assert.equal(storage.data.size, 1);
});

test('恢复协议：响应校验不通过按结果未知处理', async () => {
  const { recovery, storage } = harness({ validResult: () => false });
  await recovery.prepare({ action: 'accept', payload: { orderId: 'ord_1' } });
  await assert.rejects(recovery.submit(),
    (error) => error.code === 'PROTOCOL_ERROR' && error.uncertain === true);
  assert.equal(storage.data.size, 1);
});

test('恢复协议：记录归属或结构不符时拒绝，不误当成本人草稿', async () => {
  const storage = memoryStorage({
    'bakery.checkout.v1:fulfillment:buyer-1': { schema: 1, subjectId: 'other-user', command: { action: 'accept' } }
  });
  const { recovery } = harness({ storage });
  await assert.rejects(recovery.inspect(),
    (error) => error.code === 'INVALID_FULFILLMENT_RECORD');
});

test('恢复协议：存储读写异常映射为存储错误，不冒充无草稿', async () => {
  const storage = {
    async get() { throw new Error('quota'); },
    async set() { throw new Error('quota'); },
    async remove() { throw new Error('quota'); }
  };
  const { recovery } = harness({ storage });
  await assert.rejects(recovery.inspect(), (error) => error.code === 'FULFILLMENT_STORAGE_ERROR');
  await assert.rejects(recovery.prepare({ action: 'accept', orderId: 'ord_1' }),
    (error) => error.code === 'FULFILLMENT_STORAGE_ERROR');
});

test('恢复协议：身份切换后旧草稿不可再用', async () => {
  const { recovery, runtime } = harness();
  await recovery.prepare({ action: 'accept', payload: { orderId: 'ord_1' } });
  runtime.subjectId = 'buyer-2';
  await assert.rejects(recovery.inspect(), (error) => error.code === 'SESSION_CHANGED');
});

test('恢复协议：缺少可信运行时或存储时在创建阶段拒绝', () => {
  const storage = memoryStorage();
  const base = {
    runtime: { checkoutNamespace: 'bakery.checkout.v1', subjectId: 'buyer-1', assertIdentity: async () => {} },
    storage,
    scope: 'fulfillment',
    normalize: input => input,
    send: async () => ({ ok: true }),
    validResult: () => true,
    errors: { invalid: 'A', storage: 'B', pending: 'C' }
  };
  const invalidRequest = error => error instanceof TradeApiError && error.code === 'INVALID_REQUEST';
  assert.throws(() => createOperationRecovery({ ...base, storage: null }), invalidRequest);
  assert.throws(() => createOperationRecovery({ ...base, runtime: null }), invalidRequest);
  assert.throws(() => createOperationRecovery({ ...base, errors: null }), invalidRequest);
  assert.throws(() => createOperationRecovery({ ...base, scope: undefined }), invalidRequest);
});

test('履约恢复与售后恢复共用同一套存储契约', async () => {
  const { createFulfillmentRecovery } = require('../shared/fulfillment-recovery');
  const { createAfterSaleRecovery } = require('../shared/after-sale-recovery');
  const storage = memoryStorage();
  const client = {
    fulfillment: {
      accept: async payload => ({ _id: payload.orderId, version: payload.expectedVersion + 1, status: 'ACCEPTED' })
    },
    afterSales: {
      apply: async payload => ({ _id: 'as_1', ownerOpenid: 'buyer-1', orderId: payload.orderId,
        reason: payload.reason, status: 'REQUESTED', version: 1 })
    }
  };
  const runtime = {
    client, checkoutNamespace: 'bakery.checkout.v1', subjectId: 'buyer-1',
    assertIdentity: async () => {}
  };

  const fulfillment = createFulfillmentRecovery({ runtime, storage });
  await fulfillment.prepare({ action: 'accept', payload: {
    orderId: 'ord_1', requestId: 'req-12345678', expectedVersion: 1
  } });
  const accepted = await fulfillment.submit();
  assert.equal(accepted.result.status, 'ACCEPTED');
  assert.equal(storage.data.size, 0);

  const afterSale = createAfterSaleRecovery({ runtime, storage });
  await afterSale.prepare({ type: 'apply', payload: {
    orderId: 'ord_1', requestId: 'req-87654321', reason: '商品破损'
  } });
  const applied = await afterSale.submit();
  assert.equal(applied.result.status, 'REQUESTED');
  assert.equal(storage.data.size, 0);

  // 店主角色的售后恢复不能执行顾客的申请动作
  const ownerView = createAfterSaleRecovery({ runtime, storage, owner: true });
  await assert.rejects(ownerView.prepare({ type: 'apply', payload: {
    orderId: 'ord_1', requestId: 'req-11223344', reason: 'x'
  } }), (error) => error.code === 'INVALID_AFTER_SALE_RECORD');
});
test('恢复协议：放弃记录必须显式确认，未确认时拒绝并保留记录', async () => {
  const { recovery, storage } = harness();
  await recovery.prepare({ action: 'accept', payload: { orderId: 'ord_1' } });
  await assert.rejects(recovery.discard(),
    (error) => error.code === 'FULFILLMENT_RECOVERY_REQUIRED');
  assert.equal(storage.data.size, 1, '未确认时不能丢记录');
  const result = await recovery.discard({ acknowledgeUncertain: true });
  assert.equal(result.discarded, true);
  assert.equal(storage.data.size, 0);
  assert.equal(await recovery.inspect(), null);
});

test('恢复协议：记录损坏时只有明确确认才能清理', async () => {
  const storage = memoryStorage({
    'bakery.checkout.v1:fulfillment:buyer-1': { schema: 1, subjectId: 'other-user', command: {} }
  });
  const { recovery } = harness({ storage });
  await assert.rejects(recovery.discard(), (error) => error.code === 'INVALID_FULFILLMENT_RECORD');
  const cleared = await recovery.discard({ acknowledgeUncertain: true });
  assert.equal(cleared.discarded, true);
  assert.equal(storage.data.size, 0);
});
