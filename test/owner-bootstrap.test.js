'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { OwnerBootstrap } = require('../cloudfunctions/api/setup/owner-bootstrap');
const { StaffAuthService } = require('../cloudfunctions/api/domain/staff-auth-service');
const { verifyPassword } = require('../cloudfunctions/api/domain/passwords');
const { createApplication } = require('../cloudfunctions/api/application');
const { MemoryRepository } = require('./support/memory-repository');

// 仅测试使用；部署没有默认口令。
const password = 'DemoOnly-Bootstrap-2026';
const input = () => ({ ownerOpenid: 'owner-demo', password });
const code = expected => error => error.code === expected;
function fixture(seed) {
  const repository = new MemoryRepository(seed);
  return { repository, bootstrap: new OwnerBootstrap(repository, { clock: () => 1000000 }) };
}

test('初始化：首个店主、随机盐口令与标记原子创建，能接入现有员工登录', async () => {
  const { repository, bootstrap } = fixture();
  const result = await bootstrap.initialize(input());
  assert.deepEqual(result, { initialized: true, changed: true });
  const state = repository.snapshot();
  assert.equal(state.users['owner-demo'].role, 'owner');
  assert.equal(state.staff_credentials['owner-demo'].passwordVersion, 1);
  assert.ok(!JSON.stringify(state).includes(password));
  assert.ok(!JSON.stringify(result).includes('passwordHash'));
  const auth = new StaffAuthService(repository, { clock: () => 1000000 });
  const login = await auth.login('owner-demo', password);
  assert.equal(login.role, 'owner');
  assert.equal((await auth.resolveActor('owner-demo', login.token)).staffVerified, true);
});

test('初始化：同一店主重试不重设口令、不清会话、不重复记录事件', async () => {
  const { repository, bootstrap } = fixture();
  await bootstrap.initialize(input());
  const before = repository.snapshot();
  assert.deepEqual(await bootstrap.initialize({ ...input(), password: 'DemoOnly-Changed-2026' }),
    { initialized: true, changed: false });
  assert.deepEqual(repository.snapshot(), before);
  const encoded = before.staff_credentials['owner-demo'].passwordHash;
  assert.equal(await verifyPassword(password, encoded), true);
  assert.equal(await verifyPassword('DemoOnly-Changed-2026', encoded), false);
});

test('初始化：两个不同初始店主竞争时仅一个成功，不产生两个新店主', async () => {
  const { repository, bootstrap } = fixture();
  const results = await Promise.allSettled(['owner-a', 'owner-b'].map(ownerOpenid => bootstrap.initialize({ ownerOpenid, password })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'BOOTSTRAP_CONFLICT');
  assert.equal(Object.keys(repository.snapshot().users).length, 1);
  assert.equal(Object.keys(repository.snapshot().auth_events).length, 1);
});

test('初始化：同一店主并发重试只创建一套记录', async () => {
  const { repository, bootstrap } = fixture();
  const results = await Promise.all([bootstrap.initialize(input()), bootstrap.initialize(input())]);
  assert.equal(results.filter(result => result.changed).length, 1);
  assert.equal(Object.keys(repository.snapshot().staff_credentials).length, 1);
});

test('初始化：既有顾客、员工或残留口令不能被静默覆盖提升为店主', async () => {
  for (const seed of [{ users: { 'owner-demo': { role: 'customer', active: true } } },
    { users: { 'owner-demo': { role: 'staff', active: true } } },
    { staff_credentials: { 'owner-demo': { passwordHash: 'existing' } } }]) {
    const { repository, bootstrap } = fixture(seed);
    await assert.rejects(bootstrap.initialize(input()), code('BOOTSTRAP_CONFLICT'));
    assert.deepEqual(repository.snapshot(), seed);
  }
});

test('初始化：标记存在但账号缺失或损坏时拒绝自动修复', async () => {
  const { repository, bootstrap } = fixture();
  await bootstrap.initialize(input());
  await repository.transaction(tx => tx.set('users', 'owner-demo', { openid: 'owner-demo', role: 'customer', active: true, authVersion: 0 }));
  const before = repository.snapshot();
  await assert.rejects(bootstrap.initialize(input()), code('BOOTSTRAP_INCONSISTENT'));
  assert.deepEqual(repository.snapshot(), before);
});

test('初始化：提交失败不残留账号、标记或日志，原参数可重试', async () => {
  const { repository, bootstrap } = fixture();
  repository.failNextCommit = true;
  await assert.rejects(bootstrap.initialize(input()), /INJECTED_COMMIT_FAILURE/);
  assert.deepEqual(repository.snapshot(), {});
  assert.equal((await bootstrap.initialize(input())).changed, true);
});

test('初始化：客户端不能用伪造系统身份调用初始化动作', async () => {
  const { repository } = fixture();
  const application = createApplication({ repository, resolveIdentity: async () => ({ openid: 'buyer-demo' }) });
  for (const action of ['setup.owner', 'staff.bootstrap', 'owner.initialize']) {
    const response = await application.handle({ action, data: { ...input(), trustedSystem: true } }, {});
    assert.equal(response.error.code, 'INVALID_ACTION');
  }
  assert.deepEqual(repository.snapshot(), {});
});

test('初始化：非法身份或弱口令在写入前拒绝', async () => {
  const { repository, bootstrap } = fixture();
  await assert.rejects(bootstrap.initialize({ ...input(), ownerOpenid: '../bad' }), code('UNAUTHENTICATED'));
  await assert.rejects(bootstrap.initialize({ ...input(), password: 'short' }), code('INVALID_PASSWORD'));
  assert.deepEqual(repository.snapshot(), {});
});
