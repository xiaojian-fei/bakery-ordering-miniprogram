'use strict';
const { MemoryRepository } = require('./memory-repository');
const { CatalogService } = require('../../cloudfunctions/api/domain/catalog-service');
const { AddressService } = require('../../cloudfunctions/api/domain/address-service');
const { CartService } = require('../../cloudfunctions/api/domain/cart-service');
const { OrderService } = require('../../cloudfunctions/api/domain/order-service');
const { FulfillmentService } = require('../../cloudfunctions/api/domain/fulfillment-service');
const { AfterSaleService } = require('../../cloudfunctions/api/domain/after-sale-service');
const { RefundService } = require('../../cloudfunctions/api/domain/refund-service');
const { OrderQueryService } = require('../../cloudfunctions/api/domain/order-query-service');
const { StatisticsService } = require('../../cloudfunctions/api/domain/statistics-service');

const buyer = { openid: 'buyer-demo', role: 'customer' };
const other = { openid: 'other-demo', role: 'customer' };
const owner = { openid: 'owner-demo', role: 'owner', staffVerified: true };
const staff = { openid: 'staff-demo', role: 'staff', staffVerified: true };
const addressInput = (change = {}) => ({ addressId: 'home', requestId: 'address-001', expectedVersion: 0,
  name: '测试顾客', phone: '00000000000', province: '内蒙古', city: '测试市', district: '测试区',
  detail: '虚构地址', makeDefault: true, ...change });

function shopFixture() {
  let now = 1000000;
  const clock = () => now;
  const repository = new MemoryRepository({ products: {
    bread: { _id: 'bread', name: '测试司康', priceCents: 1250, category: '司康', isOnSale: true,
      onHand: 30, reserved: 0, inventoryVersion: 0, catalogVersion: 0 },
    cookie: { _id: 'cookie', name: '测试饼干', priceCents: 500, category: '饼干', isOnSale: true,
      onHand: 50, reserved: 0, inventoryVersion: 0, catalogVersion: 0 }
  } });
  const construct = Service => new Service(repository, { clock });
  const orders = construct(OrderService);
  let sequence = 0;
  async function paid({ delivery = false, quantity = 2, actor = buyer } = {}) {
    sequence += 1;
    if (delivery) await construct(AddressService).save(actor, addressInput({
      addressId: 'home-' + sequence, requestId: 'address-paid-' + sequence }));
    const order = await orders.create(actor, { requestId: 'checkout-' + sequence,
      deliveryType: delivery ? 'delivery' : 'pickup', ...(delivery ? { addressId: 'home-' + sequence } : {}),
      items: [{ productId: 'bread', quantity }] });
    return orders.simulatePay(actor, order._id);
  }
  return { repository, clock, setTime: value => { now = value; }, paid, orders,
    catalog: construct(CatalogService), addresses: construct(AddressService), cart: construct(CartService),
    fulfillment: construct(FulfillmentService), afterSales: construct(AfterSaleService),
    refunds: construct(RefundService), queries: construct(OrderQueryService), statistics: construct(StatisticsService) };
}

module.exports = { shopFixture, buyer, other, owner, staff, addressInput };
