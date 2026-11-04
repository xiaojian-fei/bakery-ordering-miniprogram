'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { startPreviewServer, generateProjects } = require('../scripts/local-miniapp-preview');

test('本机小程序预览：三个项目经实际 HTTP 共用订单，角色由本机令牌决定', async t => {
  const preview = await startPreviewServer();
  const temp = await fs.realpath(os.tmpdir());
  const scratch = await fs.mkdtemp(path.join(temp, 'bakery-miniapp-test-'));
  const originalWx = global.wx;
  t.after(async () => {
    if (originalWx === undefined) delete global.wx;
    else global.wx = originalWx;
    await new Promise((resolve, reject) => preview.server.close(error => error ? reject(error) : resolve()));
    const resolved = await fs.realpath(scratch);
    if (path.dirname(resolved) === temp && path.basename(resolved).startsWith('bakery-miniapp-test-')) {
      await fs.rm(resolved, { recursive: true, force: true });
    }
  });
  const projects = await generateProjects(preview, scratch);
  assert.equal(preview.server.address().address, '127.0.0.1');
  const withoutToken = await fetch(preview.url, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'identity.me' }) });
  assert.equal(withoutToken.status, 403);
  const runtimes = {};
  global.wx = { request(options) {
    fetch(options.url, { method: options.method, headers: options.header, body: JSON.stringify(options.data) })
      .then(async response => options.success({ statusCode: response.status, data: await response.json() }))
      .catch(options.fail);
  } };
  for (const [role, project] of Object.entries(projects)) {
    const config = JSON.parse(await fs.readFile(path.join(project, 'project.config.json'), 'utf8'));
    assert.equal(config.appid, 'touristappid');
    assert.equal(config.setting.urlCheck, false);
    await assert.rejects(fs.stat(path.join(project, 'cloudfunctions')), { code: 'ENOENT' });
    runtimes[role] = require(path.join(project, 'services/miniapp-config.js'));
    await runtimes[role].assertIdentity();
    assert.equal(runtimes[role].subjectId, role + '-demo');
  }
  const { buyer, staff, owner } = runtimes;
  const badRole = await fetch(preview.url, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-preview-token': preview.tokens.buyer },
    body: JSON.stringify({ action: 'staff.login', role: 'owner', data: { password: 'LOCAL_DEMO_ONLY' } }) });
  assert.equal((await badRole.json()).error.code, 'AUTH_FAILED');
  await assert.rejects(staff.client.staff.login('wrong'), { code: 'AUTH_FAILED' });
  await staff.client.staff.login('LOCAL_DEMO_ONLY');
  await owner.client.staff.login('LOCAL_DEMO_ONLY');
  await assert.rejects(staff.client.statistics.summary({ startAt: 1, endAt: 2 }), { code: 'FORBIDDEN' });
  const order = await buyer.client.orders.create({ requestId: buyer.newCheckoutRequestId(), deliveryType: 'pickup',
    items: [{ productId: 'bread', quantity: 1 }] });
  await buyer.client.orders.pay(order._id);
  const visible = (await staff.client.orders.list({ manage: true })).items.find(item => item._id === order._id);
  const accepted = await staff.client.fulfillment.accept({ orderId: visible._id, expectedVersion: visible.version,
    requestId: staff.newCheckoutRequestId() });
  assert.equal(accepted.status, 'ACCEPTED');
  assert.equal((await buyer.client.orders.get(order._id)).status, 'ACCEPTED');
  const ready = await staff.client.fulfillment.readyForPickup({ orderId: order._id, expectedVersion: accepted.version,
    requestId: staff.newCheckoutRequestId() });
  const { code } = await buyer.client.orders.pickupCode(order._id);
  await staff.client.fulfillment.complete({ orderId: order._id, expectedVersion: ready.version,
    requestId: staff.newCheckoutRequestId(), pickupCode: code });
  assert.equal((await buyer.client.orders.get(order._id)).status, 'COMPLETED');
  const now = Date.now();
  const statistics = await owner.client.statistics.summary({ startAt: now - 60000, endAt: now + 60000 });
  assert.equal(statistics.grossCents, 1250);
  assert.equal(statistics.completedOrderCount, 1);
});
