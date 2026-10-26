'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const http = require('node:http');
const { createWorkbench } = require('../scripts/local-workbench');

async function fixture(t) {
  const { server } = await createWorkbench();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const initial = await fetch(base + '/demo/state');
  const cookie = initial.headers.get('set-cookie').split(';')[0];
  const post = (url, body, headers = {}) => fetch(base + url, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base, Cookie: cookie, ...headers }, body: JSON.stringify(body) });
  return { base, cookie, post };
}

test('本地工作台：仅本机HTTP，界面/客户端包可加载，未暴露初始化口令', async t => {
  const { base } = await fixture(t);
  const html = await (await fetch(base)).text();
  assert.ok(html.includes('虚构数据'));
  assert.ok(html.includes('模拟支付'));
  for (const file of ['/client.js', '/app.js']) {
    const response = await fetch(base + file);
    assert.equal(response.status, 200);
    const source = await response.text();
    assert.doesNotThrow(() => new vm.Script(source));
  }
  const state = await (await fetch(base + '/demo/state')).json();
  assert.deepEqual(Object.keys(state).sort(), ['identity', 'mode', 'now']);
  assert.equal(state.mode, 'LOCAL_DEMO');
});

test('本地工作台：身份切换是显式演示动作，真实应用入口仍要求员工会话', async t => {
  const { post } = await fixture(t);
  let result = await (await post('/api', { action: 'catalog.save', role: 'owner', data: {} })).json();
  assert.equal(result.error.code, 'FORBIDDEN');
  await post('/demo/identity', { identity: 'owner' });
  result = await (await post('/api', { action: 'statistics.summary', data: {} })).json();
  assert.equal(result.error.code, 'FORBIDDEN');
  const login = await (await post('/api', { action: 'staff.login', data: { password: 'LOCAL_DEMO_ONLY' } })).json();
  assert.equal(login.data.role, 'owner');
  const now = Date.now();
  result = await (await post('/api', { action: 'statistics.summary', staffToken: login.data.token,
    data: { startAt: now - 86400000, endAt: now + 1 } })).json();
  assert.equal(result.success, true);
  assert.equal(result.data.grossCents, 0);
});

test('本地工作台：拒绝跨来源、错误Host、越界静态路径、非法JSON与超大请求', async t => {
  const { base, cookie, post } = await fixture(t);
  assert.equal((await post('/api', {}, { Origin: 'https://example.invalid' })).status, 403);
  const wrongHost = await new Promise((resolve, reject) => {
    http.get(base, { headers: { Host: 'example.invalid' } }, response => {
      response.resume(); resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(wrongHost, 403);
  assert.equal((await fetch(base + '/package.json')).status, 404);
  const broken = await fetch(base + '/api', { method: 'POST', headers: {
    'Content-Type': 'application/json', Origin: base, Cookie: cookie }, body: '{"private-fragment":broken' });
  assert.equal(broken.status, 400);
  assert.deepEqual(await broken.json(), { error: 'INVALID_JSON' });
  assert.equal((await post('/api', { data: 'x'.repeat(70000) })).status, 413);
});

test('本地工作台：后台演示任务仅店主入口可触发，业务API无系统任务动作', async t => {
  const { post } = await fixture(t);
  assert.equal((await post('/demo/dispatch', {})).status, 403);
  const direct = await (await post('/api', { action: 'notifications.run', data: { trustedSystem: true } })).json();
  assert.equal(direct.error.code, 'INVALID_ACTION');
  await post('/demo/identity', { identity: 'owner' });
  assert.equal((await post('/demo/dispatch', {})).status, 200);
  const advanced = await (await post('/demo/advance', {})).json();
  assert.equal(advanced.expiry.scanned, 0);
});
