'use strict';
const { TradeApiError } = require('./trade-errors');

const eligible = ['PENDING_ACCEPTANCE', 'ACCEPTED', 'READY_FOR_PICKUP', 'SHIPPING', 'COMPLETED'];
const saleLabels = { REQUESTED: '待审核', APPROVED: '审核通过', REJECTED: '已驳回', REFUNDED: '已退款' };
const identityLost = error => ['SESSION_CHANGED', 'UNAUTHENTICATED', 'ACCOUNT_DISABLED'].includes(error?.code);
const errorText = error => error instanceof TradeApiError ? error.message : '操作失败，请重试';

function orderActions(order) {
  return {
    version: order.version,
    canPay: order.status === 'PENDING_PAYMENT',
    canPickup: order.status === 'READY_FOR_PICKUP' && order.paymentStatus === 'PAID',
    canApply: eligible.includes(order.status) && order.paymentStatus === 'PAID'
  };
}

function createOrderActions({ runtime, wx }) {
  let busy = false, pendingSale = null;
  const rowFor = (page, event) => page.data.orderRows.find(row => row.id === event.currentTarget.dataset.id);
  const confirm = (title, content) => new Promise((resolve, reject) =>
    wx.showModal({ title, content, success: result => resolve(result.confirm === true), fail: reject }));

  async function run(page, work) {
    if (!page._visible || busy) return;
    busy = true;
    const visit = page._orderVisit;
    const current = () => page._visible && page._orderVisit === visit;
    page.setData({ actionBusy: true, actionError: '', actionNotice: '', pickup: null });
    try {
      await runtime.assertIdentity();
      if (current()) await work(current);
    } catch (error) {
      if (current()) {
        if (identityLost(error)) page.showOrderError(error, 'error');
        else page.setData({ actionError: errorText(error) });
      }
    } finally {
      busy = false;
      if (page._visible) page.setData({ actionBusy: false, salePending: Boolean(pendingSale) });
    }
  }

  function changeOrder(page, event, action) {
    const order = rowFor(page, event);
    if (!order?.canPay) return;
    const payment = action === 'pay';
    return run(page, async current => {
      const accepted = await confirm(payment ? '确认模拟支付' : '确认取消订单',
        payment ? '模拟支付 ¥' + order.total + '，不会实际扣款。' : '取消后将释放预留库存。');
      if (!accepted || !current()) return;
      await runtime.assertIdentity();
      if (!current()) return;
      try {
        await runtime.client.orders[action](order.id, { expectedVersion: order.version, ...(payment ? { outcome: 'success' } : {}) });
        await runtime.assertIdentity();
        if (!current()) return;
        await page.refreshOrders();
        if (current()) page.setData({ actionNotice: payment ? '模拟支付成功' : '订单已取消' });
      } catch (error) {
        if (!current()) return;
        if (identityLost(error)) throw error;
        if (error.uncertain || ['VERSION_CONFLICT', 'INVALID_STATE', 'ORDER_EXPIRED'].includes(error.code)) {
          await page.refreshOrders();
        }
        if (current()) page.setData({ actionError: error.uncertain ? '结果待核对，请以刷新后的订单状态为准。' : errorText(error) });
      }
    });
  }

  async function sendSale(page, current) {
    try {
      const result = await runtime.client.afterSales.apply(pendingSale);
      pendingSale = null;
      await runtime.assertIdentity();
      if (current()) page.setData({ saleOrderId: '', saleReason: '', actionNotice: '售后申请已提交：' + result._id });
    } catch (error) {
      if (!error.uncertain) pendingSale = null;
      if (error.uncertain && current()) page.setData({ actionError: '申请结果待核对，请重试原申请。' });
      else throw error;
    }
  }

  return {
    payOrder(event) { return changeOrder(this, event, 'pay'); },
    cancelPendingOrder(event) { return changeOrder(this, event, 'cancel'); },
    revealPickup(event) {
      const order = rowFor(this, event);
      if (!order?.canPickup) return;
      return run(this, async current => {
        const result = await runtime.client.orders.pickupCode(order.id);
        await runtime.assertIdentity();
        if (current() && this.data.orderRows.some(row => row.id === order.id && row.canPickup)) {
          this.setData({ pickup: { id: order.id, code: result.code } });
        }
      });
    },
    hidePickup() { this.setData({ pickup: null }); },
    openSaleForm(event) {
      const order = rowFor(this, event);
      if (!order?.canApply || busy || pendingSale) return;
      this.setData({ saleOrderId: order.id, saleReason: '', actionError: '', actionNotice: '' });
    },
    closeSaleForm() {
      if (!busy && !pendingSale) this.setData({ saleOrderId: '', saleReason: '' });
    },
    editSaleReason(event) {
      if (!busy && !pendingSale) this.setData({ saleReason: event.detail.value });
    },
    submitSale() {
      const orderId = this.data.saleOrderId;
      const reason = this.data.saleReason.trim();
      if (pendingSale || !this.data.orderRows.some(row => row.id === orderId && row.canApply)) return;
      if (!reason || reason.length > 200) {
        this.setData({ actionError: '请输入 1 至 200 字的售后原因。' });
        return;
      }
      return run(this, async current => {
        pendingSale = { orderId, reason, requestId: runtime.newCheckoutRequestId() };
        await sendSale(this, current);
      });
    },
    retrySale() {
      if (pendingSale) return run(this, current => sendSale(this, current));
    },
    toggleSaleHistory() {
      if (busy) return;
      const showSales = !this.data.showSales;
      this.setData({ showSales, saleRows: [], saleCursor: null, pickup: null });
      if (showSales) return this.loadSaleHistory();
    },
    loadSaleHistory() {
      return run(this, async current => {
        const cursor = this.data.saleCursor;
        const result = await runtime.client.afterSales.list({ limit: 10, ...(cursor ? { cursor } : {}) });
        await runtime.assertIdentity();
        if (!current()) return;
        const rows = new Map(this.data.saleRows.map(row => [row.id, row]));
        for (const row of result.items) {
          if (row.ownerOpenid !== runtime.subjectId) throw new TradeApiError('SESSION_CHANGED');
          rows.set(row._id, { id: row._id, orderId: row.orderId, reason: row.reason,
            status: saleLabels[row.status] || '待核对', reviewReason: row.reviewReason || '' });
        }
        this.setData({ saleRows: [...rows.values()], saleCursor: result.nextCursor });
      });
    }
  };
}

module.exports = { createOrderActions, orderActions };
