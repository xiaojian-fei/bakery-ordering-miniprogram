'use strict';
const { ensure } = require('./errors');
const { requireCustomer, requireRole } = require('./auth');
const { DEFAULT_SHIPPING, requireMoney } = require('./pricing');
const { text, version, once } = require('./service-utils');

class ShopService {
  constructor(repository, { clock = Date.now } = {}) { this.repository = repository; this.clock = clock; }
  async get(actor) {
    requireCustomer(actor);
    return this.repository.transaction(async tx => {
      const info = await tx.get('shop_config', 'shop_info');
      const rules = await tx.get('shop_config', 'shipping_rules');
      return { name: info?.name || '演示烘焙店', phone: info?.phone || '', wechat: info?.wechat || '',
        address: info?.address || '', deliveryNote: info?.deliveryNote || '',
        banners: info?.banners || [], version: info?.version ?? 0, shipping: rules?.rules || DEFAULT_SHIPPING };
    });
  }
  async save(actor, input) {
    requireRole(actor, ['owner']);
    const shipping = input.shipping;
    ensure(shipping && Array.isArray(shipping.northernProvinces) && shipping.northernProvinces.length > 0
      && shipping.northernProvinces.length <= 30, 'INVALID_REQUEST', '运费地区列表不合法');
    const provinces = [...new Set(shipping.northernProvinces.map(value => text(value, '省份', 30)))].sort();
    ensure(input.banners === undefined || (Array.isArray(input.banners) && input.banners.length <= 8),
      'INVALID_REQUEST', '轮播图最多8张');
    const normalized = { expectedVersion: version(input.expectedVersion), name: text(input.name, '店铺名称', 100),
      phone: text(input.phone ?? '', '电话', 40, true), wechat: text(input.wechat ?? '', '联系账号', 80, true),
      address: text(input.address ?? '', '店铺地址', 300, true), deliveryNote: text(input.deliveryNote ?? '', '配送说明', 300, true),
      banners: (input.banners || []).map(value => text(value, '轮播图片', 1000)),
      shipping: { northernProvinces: provinces } };
    for (const field of ['northernThresholdCents', 'otherThresholdCents', 'northernFeeCents', 'otherFeeCents']) {
      normalized.shipping[field] = requireMoney(shipping[field], '运费配置');
    }
    return this.repository.transaction(tx => once(tx, actor, 'shop_save', input.requestId, normalized, async () => {
      const previous = await tx.get('shop_config', 'shop_info');
      ensure((previous?.version ?? 0) === normalized.expectedVersion, 'VERSION_CONFLICT', '店铺配置已更新');
      const nextVersion = normalized.expectedVersion + 1;
      const rules = { ...normalized.shipping, version: 'shipping-config-v' + nextVersion };
      const { expectedVersion, shipping: _, ...fields } = normalized;
      const info = { _id: 'shop_info', ...fields, version: nextVersion, updatedAt: this.clock() };
      await tx.set('shop_config', 'shop_info', info);
      await tx.set('shop_config', 'shipping_rules', { _id: 'shipping_rules', rules });
      await tx.set('shop_events', 'shop_v' + nextVersion, { action: 'CONFIG_UPDATED', operatorOpenid: actor.openid,
        version: nextVersion, createdAt: info.updatedAt });
      return { ...fields, version: nextVersion, shipping: rules };
    }));
  }
}

module.exports = { ShopService };
