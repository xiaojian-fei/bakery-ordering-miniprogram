'use strict';
const { ensure } = require('./errors');

const DEFAULT_SHIPPING = Object.freeze({
  version: 'shipping-v1',
  northernProvinces: ['黑龙江', '吉林', '辽宁', '内蒙古', '河北', '北京', '天津', '山西'],
  northernThresholdCents: 8800,
  otherThresholdCents: 10800,
  northernFeeCents: 1000,
  otherFeeCents: 1300
});

function validId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
}

function requireMoney(value, label, minimum = 0) {
  ensure(Number.isSafeInteger(value) && value >= minimum, 'INVALID_AMOUNT', label + '必须是整数分');
  return value;
}

function normalizeItems(items) {
  ensure(Array.isArray(items) && items.length > 0 && items.length <= 20,
    'INVALID_ITEMS', '每单需包含1～20行商品');
  const merged = new Map();
  for (const item of items) {
    ensure(item && validId(item.productId), 'INVALID_ITEMS', '商品ID不合法');
    ensure(Number.isSafeInteger(item.quantity) && item.quantity >= 1 && item.quantity <= 99,
      'INVALID_QUANTITY', '购买数量必须是1～99的整数');
    const quantity = (merged.get(item.productId) || 0) + item.quantity;
    ensure(quantity <= 99, 'INVALID_QUANTITY', '同商品合计数量不能超过99');
    merged.set(item.productId, quantity);
  }
  return [...merged].sort(([a], [b]) => a.localeCompare(b))
    .map(([productId, quantity]) => ({ productId, quantity }));
}

function calculateQuote(items, products, deliveryType, address, shipping = DEFAULT_SHIPPING) {
  ensure(['pickup', 'delivery'].includes(deliveryType), 'INVALID_DELIVERY', '配送方式不合法');
  const snapshots = items.map(item => {
    const product = products.get(item.productId);
    ensure(product, 'PRODUCT_NOT_FOUND', '商品不存在');
    ensure(product.isOnSale === true, 'PRODUCT_UNAVAILABLE', '商品未上架');
    requireMoney(product.priceCents, '商品价格', 1);
    const lineTotalCents = requireMoney(product.priceCents * item.quantity, '商品小计', 1);
    return { productId: item.productId, name: product.name, quantity: item.quantity,
      unitPriceCents: product.priceCents, lineTotalCents };
  });
  const subtotalCents = requireMoney(snapshots.reduce((sum, row) => sum + row.lineTotalCents, 0), '商品合计', 1);
  let shippingCents = 0;
  if (deliveryType === 'delivery') {
    ensure(address && typeof address.province === 'string' && address.province.trim(),
      'INVALID_ADDRESS', '配送地址缺少省份');
    ensure(Array.isArray(shipping.northernProvinces) && typeof shipping.version === 'string',
      'INVALID_CONFIG', '运费规则不完整');
    const northern = shipping.northernProvinces.some(province => address.province.includes(province));
    const threshold = requireMoney(northern ? shipping.northernThresholdCents : shipping.otherThresholdCents, '包邮门槛');
    const fee = requireMoney(northern ? shipping.northernFeeCents : shipping.otherFeeCents, '配送费');
    shippingCents = subtotalCents < threshold ? fee : 0;
  }
  return { items: snapshots, subtotalCents, shippingCents,
    totalCents: requireMoney(subtotalCents + shippingCents, '订单总额', 1), shippingRuleVersion: shipping.version };
}

module.exports = { DEFAULT_SHIPPING, validId, requireMoney, normalizeItems, calculateQuote };
