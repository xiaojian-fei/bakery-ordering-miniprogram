'use strict';
const { TradeApiError } = require('./trade-errors');
const { orderView } = require('./miniapp-orders');

const errorText = error => error instanceof TradeApiError ? error.message : '操作失败，请重试';
const authLost = error => ['UNAUTHENTICATED', 'FORBIDDEN', 'SESSION_CHANGED', 'ACCOUNT_DISABLED'].includes(error?.code);
const loginPath = '/pages/admin-login/admin-login';
const actions = {
  accept: '确认接单', ship: '确认发货', readyForPickup: '标记待自取',
  complete: '确认完成', reject: '拒单并模拟退款'
};
const queues = ['', 'PENDING_ACCEPTANCE', 'ACCEPTED', 'SHIPPING', 'READY_FOR_PICKUP', 'COMPLETED'];

function createStaffLoginPage({ runtime, wx }) {
  return {
    data: { unifiedMode: true, password: '', busy: false, error: '' },
    onShow() { this._visit = {}; },
    onHide() { this._visit = null; this.setData({ password: '', busy: false }); },
    onUnload() { this.onHide(); },
    enterPassword(event) { this.setData({ password: event.detail.value }); },
    async loginStaff() {
      const visit = this._visit;
      const password = this.data.password;
      if (!visit || this._loginBusy || !password) return;
      this._loginBusy = true;
      this.setData({ password: '', busy: true, error: '' });
      try {
        await runtime.assertIdentity();
        if (this._visit !== visit) return;
        await runtime.client.staff.login(password);
        await runtime.assertIdentity();
        if (this._visit === visit) wx.navigateTo({ url: '/pages/admin/admin' });
        else runtime.client.clearSession();
      } catch (error) {
        runtime.client.clearSession();
        if (this._visit === visit) this.setData({ error: errorText(error) });
      } finally {
        this._loginBusy = false;
        if (this._visit) this.setData({ busy: false });
      }
    }
  };
}

function staffRow(order) {
  let action = '';
  if (order.paymentStatus === 'PAID') {
    if (order.status === 'PENDING_ACCEPTANCE') action = 'accept';
    if (order.status === 'ACCEPTED') action = order.deliveryType === 'pickup' ? 'readyForPickup' : 'ship';
    if (order.status === 'SHIPPING' || order.status === 'READY_FOR_PICKUP') action = 'complete';
  }
  return { ...orderView(order), action, actionLabel: actions[action] || '', needsCode: order.status === 'READY_FOR_PICKUP',
    canReject: action === 'accept' };
}

function createStaffOrdersPage({ runtime, wx }) {
  let pending = null, writing = false;
  const client = runtime.client;
  const confirm = action => new Promise((resolve, reject) => wx.showModal({
    title: actions[action], content: action === 'reject' ? '确认后将拒单并记录整单模拟退款。' : '请核对订单和履约信息后确认。',
    success: result => resolve(result.confirm === true), fail: reject
  }));
  async function authorized() {
    await runtime.assertIdentity();
    if (!client.getSession()) throw new TradeApiError('UNAUTHENTICATED');
  }
  return {
    data: { unifiedMode: true, rows: [], cursor: null, filter: 0,
      filters: ['全部订单', '待接单', '已接单', '配送中', '待自取', '已完成'],
      loading: false, busy: false, error: '', notice: '', loginRequired: false, pending: false, owner: false,
      form: null, carrier: '', trackingNo: '', pickupCode: '', rejectionReason: '' },
    onShow() {
      this._visit = {};
      this.setData({ busy: writing, notice: '', pending: Boolean(pending), owner: client.getSession()?.role === 'owner' });
      return this.refreshStaffOrders();
    },
    onHide() {
      this._visit = null;
      this._query = null;
      this.resetForm();
      this.setData({ rows: [], cursor: null });
    },
    onUnload() { this.onHide(); pending = null; },
    resetForm() { this.setData({ form: null, carrier: '', trackingNo: '', pickupCode: '', rejectionReason: '' }); },
    staffError(error) {
      if (authLost(error)) {
        client.clearSession();
        this._query = null;
        this.resetForm();
        this.setData({ rows: [], cursor: null, loginRequired: true, loading: false });
      }
      this.setData({ error: errorText(error) });
    },
    openStaffLogin() { wx.navigateTo({ url: loginPath }); },
    openOwnerSales() {
      if (!writing && client.getSession()?.role === 'owner') wx.navigateTo({ url: '/pages/admin/after-sales/after-sales' });
    },
    openOwnerStatistics() {
      if (!writing && client.getSession()?.role === 'owner') wx.navigateTo({ url: '/pages/admin/statistics/statistics' });
    },
    openOwnerCatalog() {
      if (!writing && client.getSession()?.role === 'owner') wx.navigateTo({ url: '/pages/admin/catalog/catalog' });
    },
    openOwnerShop() {
      if (!writing && client.getSession()?.role === 'owner') wx.navigateTo({ url: '/pages/admin/shop/shop' });
    },
    async logoutStaff() {
      if (writing) return;
      this.onHide();
      pending = null;
      this.setData({ rows: [], cursor: null, pending: false, loginRequired: true });
      try {
        await client.staff.logout();
      } catch (error) {
        this.setData({ error: '本机已退出，会话撤销结果待核对。' });
      }
    },
    chooseStaffFilter(event) {
      const filter = Number(event.detail.value);
      if (writing || !Number.isInteger(filter) || filter < 0 || filter >= queues.length) return;
      this.setData({ filter });
      return this.refreshStaffOrders();
    },
    refreshStaffOrders() {
      this.resetForm();
      this.setData({ rows: [], cursor: null });
      return this.loadStaffOrders(false);
    },
    moreStaffOrders() {
      if (!writing && !this.data.loading && this.data.cursor) return this.loadStaffOrders(true);
    },
    async loadStaffOrders(append) {
      if (!this._visit) return;
      const query = this._query = {};
      const current = () => this._visit && this._query === query;
      const cursor = append ? this.data.cursor : null;
      const status = queues[this.data.filter];
      this.setData({ loading: true, error: '', loginRequired: false });
      try {
        await authorized();
        const result = await client.orders.list({ manage: true, limit: 10,
          ...(cursor ? { cursor } : {}), ...(status ? { status } : {}) });
        await authorized();
        if (!current()) return;
        const rows = new Map((append ? this.data.rows : []).map(row => [row.id, row]));
        for (const order of result.items) rows.set(order._id, staffRow(order));
        this.setData({ rows: [...rows.values()], cursor: result.nextCursor });
      } catch (error) {
        if (current()) this.staffError(error);
      } finally {
        if (current()) this.setData({ loading: false });
      }
    },
    openFulfillment(event) {
      const row = this.data.rows.find(item => item.id === event.currentTarget.dataset.id);
      if (writing || pending || !row?.action) return;
      this.resetForm();
      this.setData({ form: row, error: '', notice: '' });
    },
    openRejection(event) {
      const row = this.data.rows.find(item => item.id === event.currentTarget.dataset.id);
      if (writing || pending || !row?.canReject || client.getSession()?.role !== 'owner') return;
      this.resetForm();
      this.setData({ form: { ...row, action: 'reject' }, error: '', notice: '' });
    },
    enterCarrier(event) { this.setData({ carrier: event.detail.value }); },
    enterTracking(event) { this.setData({ trackingNo: event.detail.value }); },
    enterPickupCode(event) { this.setData({ pickupCode: event.detail.value }); },
    enterRejectionReason(event) { this.setData({ rejectionReason: event.detail.value }); },
    submitFulfillment() {
      const form = this.data.form;
      if (!form || pending || writing) return;
      const carrier = this.data.carrier.trim(), trackingNo = this.data.trackingNo.trim();
      const pickupCode = this.data.pickupCode.trim().toUpperCase();
      const reason = this.data.rejectionReason.trim();
      if (form.action === 'reject' && (!reason || reason.length > 200)) {
        this.setData({ error: '请输入 1 至 200 字的拒单原因。' }); return;
      }
      if (form.action === 'ship' && (!carrier || carrier.length > 60 || !/^[A-Za-z0-9_-]{4,80}$/.test(trackingNo))) {
        this.setData({ error: '请填写承运方及 4 至 80 位有效运单号。' }); return;
      }
      if (form.needsCode && !/^[A-F0-9]{12}$/.test(pickupCode)) {
        this.setData({ error: '请输入顾客出示的 12 位自取码。' }); return;
      }
      return this.writeFulfillment({ action: form.action, payload: { orderId: form.id, expectedVersion: form.version,
        ...(form.action === 'ship' ? { carrier, trackingNo } : {}), ...(form.needsCode ? { pickupCode } : {}),
        ...(form.action === 'reject' ? { reason } : {}) } });
    },
    retryFulfillment() { if (pending) return this.writeFulfillment(pending, true); },
    async writeFulfillment(operation, retry = false) {
      const visit = this._visit;
      if (!visit || writing) return;
      const current = () => this._visit === visit;
      writing = true;
      this.setData({ busy: true, error: '', notice: '' });
      try {
        await authorized();
        if (!current()) return;
        if (!retry) {
          if (!await confirm(operation.action) || !current()) return;
          await authorized();
          if (!current()) return;
          pending = { action: operation.action,
            payload: { ...operation.payload, requestId: runtime.newCheckoutRequestId() } };
        }
        if (pending.action === 'reject') await client.orders.reject(pending.payload);
        else await client.fulfillment[pending.action](pending.payload);
        pending = null;
        await authorized();
        if (current()) {
          await this.refreshStaffOrders();
          if (current() && !this.data.error) this.setData({ notice: operation.action === 'reject' ? '已拒单并记录模拟退款。' : '订单状态已更新。' });
        }
      } catch (error) {
        if (!error.uncertain && !authLost(error)) pending = null;
        if (current()) {
          if (['VERSION_CONFLICT', 'INVALID_STATE'].includes(error.code)) await this.refreshStaffOrders();
          if (current()) {
            if (error.uncertain && pending) this.setData({ error: '结果待核对，请重试原履约操作。' });
            else this.staffError(error);
          }
        }
      } finally {
        writing = false;
        if (this._visit) this.setData({ busy: false, pending: Boolean(pending) });
      }
    }
  };
}

module.exports = { createStaffLoginPage, createStaffOrdersPage };
