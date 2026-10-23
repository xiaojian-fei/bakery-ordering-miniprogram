'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { hashPassword, verifyPassword } = require('../cloudfunctions/api/domain/passwords');
const { authFixture, DEMO_PASSWORD } = require('./support/auth-fixture');
const code = expected => error => error.code === expected;
const owner = { openid: 'owner-demo', role: 'owner', staffVerified: true };

test('FR-01 相同口令使用随机盐生成不同哈希，验证失败不抛泄露原文的错误', async () => {
  const first = await hashPassword(DEMO_PASSWORD);
  const second = await hashPassword(DEMO_PASSWORD);
  assert.notEqual(first, second);
  assert.ok(!first.includes(DEMO_PASSWORD));
  assert.equal(await verifyPassword(DEMO_PASSWORD, first), true);
  assert.equal(await verifyPassword('wrong-demo-password', first), false);
  assert.equal(await verifyPassword(DEMO_PASSWORD, 'scrypt$invalid'), false);
  await assert.rejects(hashPassword('short'), code('INVALID_PASSWORD'));
  await assert.rejects(hashPassword('a'.repeat(129)), code('INVALID_PASSWORD'));
});

test('FR-01 正确登录产生身份绑定会话，库中不保存原始令牌或明文口令', async () => {
  const { auth, repository } = await authFixture();
  const session = await auth.login(owner.openid, DEMO_PASSWORD);
  assert.match(session.token, /^[0-9a-f]{64}$/);
  assert.equal(session.role, 'owner');
  const serialized = JSON.stringify(repository.snapshot());
  assert.ok(!serialized.includes(DEMO_PASSWORD));
  assert.ok(!serialized.includes(session.token));
  assert.deepEqual(await auth.resolveActor(owner.openid, session.token), owner);
  await assert.rejects(auth.resolveActor('staff-demo', session.token), code('UNAUTHENTICATED'));
});

test('FR-01 没有员工令牌时不能仅凭用户记录中的店主角色提权', async () => {
  const { auth } = await authFixture();
  assert.deepEqual(await auth.resolveActor(owner.openid), { openid: owner.openid, role: 'customer' });
  assert.deepEqual(await auth.resolveActor('new-customer'), { openid: 'new-customer', role: 'customer' });
  await assert.rejects(auth.resolveActor(owner.openid, 'forged'), code('UNAUTHENTICATED'));
  await assert.rejects(auth.login('new-customer', DEMO_PASSWORD), code('AUTH_FAILED'));
});

test('FR-01 错误口令累计次数真正提交，达到阈值锁定，锁定过期可重新登录', async () => {
  const { auth, repository, setTime } = await authFixture({ maxFailures: 2, lockMs: 100 });
  await assert.rejects(auth.login(owner.openid, 'wrong-demo-password'), code('AUTH_FAILED'));
  assert.equal(repository.snapshot().staff_credentials[owner.openid].failedAttempts, 1);
  await assert.rejects(auth.login(owner.openid, 'wrong-demo-password'), code('AUTH_LOCKED'));
  await assert.rejects(auth.login(owner.openid, DEMO_PASSWORD), code('AUTH_LOCKED'));
  assert.equal(Object.keys(repository.snapshot().staff_sessions || {}).length, 0);
  setTime(1000100);
  const result = await auth.login(owner.openid, DEMO_PASSWORD);
  assert.ok(result.token);
  assert.equal(repository.snapshot().staff_credentials[owner.openid].failedAttempts, 0);
});

test('FR-01 同时失败的登录不会丢失计数，锁定解除后失败窗口重新开始', async () => {
  const { auth, repository, setTime } = await authFixture({ maxFailures: 2, lockMs: 100 });
  const attempts = await Promise.allSettled(Array.from({ length: 3 }, () => auth.login(owner.openid, 'wrong-demo-password')));
  assert.ok(attempts.every(result => result.status === 'rejected'));
  assert.equal(repository.snapshot().staff_credentials[owner.openid].failedAttempts, 2);
  setTime(1000100);
  await assert.rejects(auth.login(owner.openid, 'wrong-demo-password'), code('AUTH_FAILED'));
  assert.equal(repository.snapshot().staff_credentials[owner.openid].failedAttempts, 1);
});

test('FR-01 会话在截止瞬间失效，注销可以重复且不可注销他人会话', async () => {
  const { auth, setTime } = await authFixture({ sessionTtlMs: 100 });
  const first = await auth.login(owner.openid, DEMO_PASSWORD);
  await assert.rejects(auth.logout('staff-demo', first.token), code('UNAUTHENTICATED'));
  await auth.logout(owner.openid, first.token);
  await auth.logout(owner.openid, first.token);
  await assert.rejects(auth.resolveActor(owner.openid, first.token), code('UNAUTHENTICATED'));
  const second = await auth.login(owner.openid, DEMO_PASSWORD);
  setTime(second.expiresAt);
  await assert.rejects(auth.resolveActor(owner.openid, second.token), code('UNAUTHENTICATED'));
});

test('FR-01 店主重设口令后旧会话和旧口令失效', async () => {
  const { auth } = await authFixture();
  const previous = await auth.login('staff-demo', DEMO_PASSWORD);
  await auth.setPassword(owner, 'staff-demo', 'DemoOnly-Replaced-2026');
  await assert.rejects(auth.resolveActor('staff-demo', previous.token), code('UNAUTHENTICATED'));
  await assert.rejects(auth.login('staff-demo', DEMO_PASSWORD), code('AUTH_FAILED'));
  assert.ok((await auth.login('staff-demo', 'DemoOnly-Replaced-2026')).token);
  await assert.rejects(auth.setPassword({ openid: 'staff-demo', role: 'staff', staffVerified: true }, owner.openid, DEMO_PASSWORD), code('FORBIDDEN'));
});

test('FR-01 角色变化、授权版本变化和停用账号使旧会话失效', async () => {
  for (const patch of [{ role: 'customer' }, { authVersion: 1 }, { active: false }]) {
    const { auth, repository } = await authFixture();
    const session = await auth.login(owner.openid, DEMO_PASSWORD);
    await repository.transaction(async tx => {
      const user = await tx.get('users', owner.openid);
      await tx.set('users', owner.openid, { ...user, ...patch });
    });
    await assert.rejects(auth.resolveActor(owner.openid, session.token), code('UNAUTHENTICATED'));
    if (patch.active === false) await assert.rejects(auth.resolveActor(owner.openid), code('ACCOUNT_DISABLED'));
  }
});

test('FR-01 登录提交失败不留下可用会话或成功日志', async () => {
  const { auth, repository } = await authFixture();
  const transaction = repository.transaction.bind(repository);
  let calls = 0;
  repository.transaction = work => {
    calls += 1;
    if (calls === 2) repository.failNextCommit = true;
    return transaction(work);
  };
  await assert.rejects(auth.login(owner.openid, DEMO_PASSWORD), /INJECTED_COMMIT_FAILURE/);
  assert.equal(Object.keys(repository.snapshot().staff_sessions || {}).length, 0);
  assert.equal(Object.keys(repository.snapshot().auth_events || {}).length, 0);
});

test('FR-01 计算口令期间账号版本变化必须拒绝旧认证结果', async () => {
  const { auth, repository } = await authFixture();
  const transaction = repository.transaction.bind(repository);
  let calls = 0;
  repository.transaction = async work => {
    calls += 1;
    if (calls === 2) await transaction(async tx => {
      const user = await tx.get('users', owner.openid);
      user.authVersion += 1;
      await tx.set('users', owner.openid, user);
    });
    return transaction(work);
  };
  await assert.rejects(auth.login(owner.openid, DEMO_PASSWORD), code('AUTH_RETRY'));
  assert.equal(Object.keys(repository.snapshot().staff_sessions || {}).length, 0);
});

test('FR-01 店主授权新员工并设置口令，撤销授权使会话失效但保留顾客身份', async () => {
  const { auth } = await authFixture();
  assert.equal((await auth.setStaffAccess(owner, 'new-staff', true)).role, 'staff');
  await assert.rejects(auth.login('new-staff', DEMO_PASSWORD), code('AUTH_FAILED'));
  await auth.setPassword(owner, 'new-staff', DEMO_PASSWORD);
  const login = await auth.login('new-staff', DEMO_PASSWORD);
  assert.equal((await auth.resolveActor('new-staff', login.token)).role, 'staff');
  await auth.setStaffAccess(owner, 'new-staff', false);
  await assert.rejects(auth.resolveActor('new-staff', login.token), code('UNAUTHENTICATED'));
  assert.equal((await auth.resolveActor('new-staff')).role, 'customer');
});

test('FR-01 重复员工授权不重复变更版本，店员不能授权且店主身份受保护', async () => {
  const { auth, repository } = await authFixture();
  const before = repository.snapshot().users['staff-demo'].authVersion;
  assert.deepEqual(await auth.setStaffAccess(owner, 'staff-demo', true), { role: 'staff', changed: false });
  assert.equal(repository.snapshot().users['staff-demo'].authVersion, before);
  await assert.rejects(auth.setStaffAccess({ openid: 'staff-demo', role: 'staff', staffVerified: true }, 'new-staff', true), code('FORBIDDEN'));
  await assert.rejects(auth.setStaffAccess(owner, owner.openid, false), code('OWNER_ACCOUNT_PROTECTED'));
  await assert.rejects(auth.setStaffAccess(owner, 'new-staff', 'owner'), code('INVALID_REQUEST'));
});

test('FR-01 员工授权提交失败不留下新身份或授权日志', async () => {
  const { auth, repository } = await authFixture();
  repository.failNextCommit = true;
  await assert.rejects(auth.setStaffAccess(owner, 'new-staff', true), /INJECTED_COMMIT_FAILURE/);
  assert.equal(repository.snapshot().users['new-staff'], undefined);
  assert.equal(Object.keys(repository.snapshot().auth_events || {}).length, 0);
});
