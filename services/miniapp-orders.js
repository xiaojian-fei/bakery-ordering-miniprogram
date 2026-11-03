'use strict';
const { TradeApiError } = require('./trade-errors');
const { createOrderActions, orderActions } = require('./miniapp-order-actions');

const labels = {
  PENDING_PAYMENT: '待支付', PENDING_ACCEPTANCE: '待接单', ACCEPTED: '已接单',
  SHIPPING: '配送中', READY_FOR_PICKUP: '待自取', COMPLETED: '已完成',
  CANCELLED: '已取消', EXPIRED: '已过期'
};
const statusLabel = status => Object.prototype.hasOwnProperty.call(labels, status) ? labels[status] : '状态待核对';
const money = cents => (cents / 100).toFixed(2);
const date = timestamp => new Date(timestamp).toLocaleString();
const message = error => error instanceof TradeApiError ? error.message : '订单加载失败，请重试';
const sessionLost = error => ['SESSION_CHANGED', 'UNAUTHENTICATED', 'ACCOUNT_DISABLED'].includes(error?.code);

function orderView(order) {
  const address = order.addressSnapshot;
  return { ...orderActions(order), id: order._id, status: statusLabel(order.status), time: date(order.createdAt),
    delivery: order.deliveryType === 'pickup' ? '自取' : '配送', remark: order.remark || '',
    address: address ? [address.name, address.phone, address.province + address.city + address.district + address.detail].join(' ') : '',
    items: order.items.map(row => ({ id: row.productId, name: row.name, quantity: row.quantity, total: money(row.lineTotalCents) })),
    subtotal: money(order.amounts.subtotalCents), shipping: money(order.amounts.shippingCents), total: money(order.amounts.totalCents) };
}

function createOrdersPage({ runtime, wx }) {
  return {
    ...createOrderActions({ runtime, wx }),
    data: { unifiedMode: true, orderRows: [], cursor: null, loading: false, error: '',
      filter: 0, filters: ['全部订单', ...Object.values(labels)], selectedId: '', events: [], eventCursor: null,
      timelineLoading: false, timelineError: '', actionBusy: false, actionNotice: '', actionError: '', pickup: null,
      saleOrderId: '', saleReason: '', salePending: false, showSales: false, saleRows: [], saleCursor: null },
    onShow() {
      this._visible = true;
      this._orderVisit = {};
      this.setData({ actionNotice: '', actionError: '', pickup: null, showSales: false, saleRows: [], saleCursor: null });
      return this.refreshOrders();
    },
    onHide() {
      this._visible = false; this._listRun = null; this._timelineRun = null;
      this.setData({ pickup: null });
    },
    onUnload() { this.onHide(); },
    changeFilter(event) {
      const filter = Number(event.detail.value);
      if (!Number.isInteger(filter) || filter < 0 || filter >= this.data.filters.length) return;
      this.setData({ filter });
      return this.refreshOrders();
    },
    refreshOrders() {
      this._timelineRun = null;
      this.setData({ orderRows: [], cursor: null, selectedId: '', events: [], eventCursor: null, pickup: null,
        saleOrderId: '', saleReason: '', timelineError: '', timelineLoading: false });
      return this.loadOrders(false);
    },
    loadMoreOrders() {
      if (!this.data.loading && this.data.cursor) return this.loadOrders(true);
    },
    async loadOrders(append) {
      if (!this._visible) return;
      const run = this._listRun = {};
      const current = () => this._visible && this._listRun === run;
      const status = Object.keys(labels)[this.data.filter - 1];
      const cursor = append ? this.data.cursor : null;
      this.setData({ loading: true, error: '' });
      try {
        await runtime.assertIdentity();
        const page = await runtime.client.orders.list({ limit: 10, ...(status ? { status } : {}),
          ...(cursor ? { cursor } : {}) });
        await runtime.assertIdentity();
        if (!current()) return;
        const rows = new Map((append ? this.data.orderRows : []).map(row => [row.id, row]));
        for (const order of page.items) {
          if (order.ownerOpenid !== runtime.subjectId) throw new TradeApiError('SESSION_CHANGED');
          rows.set(order._id, orderView(order));
        }
        this.setData({ orderRows: [...rows.values()], cursor: page.nextCursor });
      } catch (error) {
        if (current()) this.showOrderError(error, 'error');
      } finally {
        if (current()) this.setData({ loading: false });
      }
    },
    selectTimeline(event) {
      const id = event.currentTarget.dataset.id;
      if (!this.data.orderRows.some(row => row.id === id)) return;
      this._timelineRun = null;
      this.setData({ selectedId: this.data.selectedId === id ? '' : id, events: [], eventCursor: null,
        timelineError: '', timelineLoading: false });
      if (this.data.selectedId) return this.loadTimeline();
    },
    async loadTimeline() {
      const orderId = this.data.selectedId;
      if (!this._visible || !orderId || this.data.timelineLoading) return;
      const run = this._timelineRun = {};
      const current = () => this._visible && this._timelineRun === run;
      this.setData({ timelineLoading: true, timelineError: '' });
      try {
        await runtime.assertIdentity();
        const cursor = this.data.eventCursor;
        const page = await runtime.client.orders.timeline({ orderId, limit: 10, ...(cursor ? { cursor } : {}) });
        await runtime.assertIdentity();
        if (!current()) return;
        this.setData({ events: [...this.data.events, ...page.items.map(row => ({
          version: row.version, label: statusLabel(row.status), time: date(row.createdAt)
        }))], eventCursor: page.nextCursor });
      } catch (error) {
        if (current()) this.showOrderError(error, 'timelineError');
      } finally {
        if (current()) this.setData({ timelineLoading: false });
      }
    },
    showOrderError(error, field) {
      if (sessionLost(error)) {
        this._listRun = null;
        this._timelineRun = null;
        this.setData({ orderRows: [], cursor: null, selectedId: '', events: [], eventCursor: null,
          loading: false, timelineLoading: false, pickup: null, saleRows: [], saleCursor: null, showSales: false,
          saleOrderId: '', saleReason: '', actionNotice: '', error: message(error) });
      } else this.setData({ [field]: message(error) });
    }
  };
}

module.exports = { createOrdersPage };
