'use strict';
const { ensure } = require('./errors');

function validateInventory(product) {
  ensure(product && Number.isSafeInteger(product.onHand) && Number.isSafeInteger(product.reserved)
    && product.reserved >= 0 && product.onHand >= product.reserved
    && Number.isSafeInteger(product.inventoryVersion ?? 0) && (product.inventoryVersion ?? 0) >= 0,
  'INVALID_INVENTORY', '库存数据不满足约束');
}

function bumpInventoryVersion(product) {
  validateInventory(product);
  ensure((product.inventoryVersion ?? 0) < Number.MAX_SAFE_INTEGER, 'INVALID_INVENTORY', '库存版本超出范围');
  product.inventoryVersion = (product.inventoryVersion ?? 0) + 1;
}

module.exports = { validateInventory, bumpInventoryVersion };
