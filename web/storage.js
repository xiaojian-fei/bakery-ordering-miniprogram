// 浏览器存储适配器：为 shared/ 的恢复模块提供异步 get/set/remove。
// 隐私模式或站点禁用存储时，读写会抛错——由调用方映射成 STORAGE_ERROR 提示，不静默丢数据。

const PROBE = '__bakery_storage_probe__';

function resolveArea() {
  const area = globalThis.localStorage;
  if (!area) throw new Error('STORAGE_UNAVAILABLE');
  // 探测一次读写：部分浏览器在隐私模式下对象存在但写入抛错。
  area.setItem(PROBE, '1');
  if (area.getItem(PROBE) !== '1') throw new Error('STORAGE_UNAVAILABLE');
  area.removeItem(PROBE);
  return area;
}

export function createBrowserStorage() {
  return {
    async get(key) {
      const raw = resolveArea().getItem(key);
      if (raw === null) return undefined;
      return JSON.parse(raw);
    },
    async set(key, value) {
      resolveArea().setItem(key, JSON.stringify(value));
    },
    async remove(key) {
      resolveArea().removeItem(key);
    },
    /** 清理本应用写入的全部草稿（切换身份或手动重置时使用）。 */
    async clearNamespace(namespace) {
      const area = resolveArea();
      const keys = [];
      for (let index = 0; index < area.length; index += 1) {
        const key = area.key(index);
        if (typeof key === 'string' && key.startsWith(namespace)) keys.push(key);
      }
      for (const key of keys) area.removeItem(key);
    }
  };
}