'use strict';
const { ensure } = require('./errors');
const { requireCustomer, requireOwner } = require('./auth');
const { id, text, version, once, page } = require('./service-utils');

const addressView = (address, defaultId) => ({ _id: address._id, name: address.name, phone: address.phone,
  province: address.province, city: address.city, district: address.district, detail: address.detail,
  version: address.version ?? 0, isDefault: address._id === defaultId });

class AddressService {
  constructor(repository, { clock = Date.now } = {}) { this.repository = repository; this.clock = clock; }

  async list(actor, input = {}) {
    requireCustomer(actor);
    return this.repository.transaction(async tx => {
      const user = await tx.get('users', actor.openid);
      const result = await page(tx, 'addresses', { filters: [{ field: 'ownerOpenid', value: actor.openid },
        { field: 'deleted', op: 'ne', value: true }], scope: actor.openid, cursor: input.cursor,
      limit: input.limit, sortBy: '_id', desc: false });
      return { ...result, items: result.items.map(address => addressView(address, user?.defaultAddressId)) };
    });
  }

  async save(actor, input) {
    requireCustomer(actor);
    const normalized = { addressId: id(input.addressId), expectedVersion: version(input.expectedVersion),
      name: text(input.name, '姓名', 80), phone: text(input.phone, '电话', 40), province: text(input.province, '省份', 80),
      city: text(input.city, '城市', 80), district: text(input.district, '区县', 80), detail: text(input.detail, '详细地址', 300),
      makeDefault: input.makeDefault ?? null };
    ensure(normalized.makeDefault === null || typeof normalized.makeDefault === 'boolean', 'INVALID_REQUEST', '默认地址标记不合法');
    return this.repository.transaction(tx => once(tx, actor, 'address_save', input.requestId, normalized, async () => {
      const existing = await tx.get('addresses', normalized.addressId);
      const currentUser = await tx.get('users', actor.openid);
      if (existing) { requireOwner(actor, existing); ensure(!existing.deleted, 'ADDRESS_NOT_FOUND', '地址已删除'); }
      ensure((existing?.version ?? 0) === normalized.expectedVersion, 'VERSION_CONFLICT', '地址已更新');
      const now = this.clock();
      const { addressId, expectedVersion, makeDefault, ...fields } = normalized;
      const address = { _id: addressId, ownerOpenid: actor.openid, ...fields, deleted: false,
        version: expectedVersion + 1, createdAt: existing?.createdAt ?? now, updatedAt: now };
      const user = currentUser || { openid: actor.openid, role: 'customer', active: true, authVersion: 0 };
      if (makeDefault === true) user.defaultAddressId = addressId;
      else if (makeDefault === false && user.defaultAddressId === addressId) user.defaultAddressId = null;
      await tx.set('addresses', addressId, address);
      await tx.set('users', actor.openid, user);
      return addressView(address, user.defaultAddressId);
    }));
  }

  async remove(actor, input) {
    requireCustomer(actor);
    const normalized = { addressId: id(input.addressId), expectedVersion: version(input.expectedVersion) };
    return this.repository.transaction(tx => once(tx, actor, 'address_remove', input.requestId, normalized, async () => {
      const address = await tx.get('addresses', normalized.addressId);
      const user = await tx.get('users', actor.openid);
      ensure(address, 'ADDRESS_NOT_FOUND', '地址不存在'); requireOwner(actor, address);
      ensure(!address.deleted && (address.version ?? 0) === normalized.expectedVersion, 'VERSION_CONFLICT', '地址已更新');
      address.deleted = true; address.version = normalized.expectedVersion + 1; address.updatedAt = this.clock();
      if (user?.defaultAddressId === address._id) user.defaultAddressId = null;
      await tx.set('addresses', address._id, address);
      if (user) await tx.set('users', actor.openid, user);
      return { removed: true, version: address.version };
    }));
  }
}

module.exports = { AddressService };
