'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

/** 最小 localStorage 替身：只需 web/storage.js 用到的那几个方法。 */
function fakeStorage() {
  const map = new Map();
  return {
    map,
    get length() { return map.size; },
    key(index) { return [...map.keys()][index] ?? null; },
    getItem(key) { return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { map.set(key, String(value)); },
    removeItem(key) { map.delete(key); },
    clear() { map.clear(); },
    failWrites: false
  };
}

async function withLocalStorage(area, work) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { value: area, configurable: true, writable: true });
  try {
    const { createBrowserStorage } = await import('../web/storage.js');
    return await work(createBrowserStorage());
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete globalThis.localStorage;
  }
}

test('浏览器存储：对象往返序列化，缺失键返回 undefined', async () => {
  const area = fakeStorage();
  await withLocalStorage(area, async storage => {
    assert.equal(await storage.get('missing'), undefined);
    await storage.set('k1', { schema: 1, subjectId: 'u1', command: { action: 'accept' } });
    assert.deepEqual(await storage.get('k1'), { schema: 1, subjectId: 'u1', command: { action: 'accept' } });
    await storage.remove('k1');
    assert.equal(await storage.get('k1'), undefined);
  });
});

test('浏览器存储：clearNamespace 只清本命名空间', async () => {
  const area = fakeStorage();
  await withLocalStorage(area, async storage => {
    await storage.set('bakery.checkout.v1:u1', { a: 1 });
    await storage.set('bakery.checkout.v1:u2', { a: 2 });
    await storage.set('other-app:key', { keep: true });
    await storage.clearNamespace('bakery.checkout.v1');
    assert.equal(await storage.get('bakery.checkout.v1:u1'), undefined);
    assert.equal(await storage.get('bakery.checkout.v1:u2'), undefined);
    assert.deepEqual(await storage.get('other-app:key'), { keep: true });
  });
});

test('浏览器存储：探测写入，禁用或抛错的存储直接报错', async () => {
  // 完全没有 localStorage（例如非浏览器环境）
  await withLocalStorage(undefined, async storage => {
    await assert.rejects(storage.get('k'), /STORAGE_UNAVAILABLE/);
    await assert.rejects(storage.set('k', 1), /STORAGE_UNAVAILABLE/);
  });

  // 对象存在但写入抛错（隐私模式的常见表现）
  const broken = fakeStorage();
  broken.setItem = () => { throw new Error('QuotaExceededError'); };
  await withLocalStorage(broken, async storage => {
    await assert.rejects(storage.set('k', 1), /QuotaExceededError/);
  });

  // 写入静默失效（getItem 读不回）
  const silent = fakeStorage();
  silent.setItem = () => {};
  await withLocalStorage(silent, async storage => {
    await assert.rejects(storage.get('k'), /STORAGE_UNAVAILABLE/);
  });
});

test('浏览器存储：内容被外部写坏时抛出解析错误而不是静默返回空', async () => {
  const area = fakeStorage();
  area.setItem('bad', 'not-json');
  await withLocalStorage(area, async storage => {
    await assert.rejects(storage.get('bad'), /JSON/);
  });
});