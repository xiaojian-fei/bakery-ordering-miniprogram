'use strict';
const { TradeApiError } = require('./trade-errors');

const statuses = ['', 'REQUESTED', 'APPROVED', 'REJECTED', 'REFUNDED'];
const labels = ['全部售后', '待审核', '审核通过', '已驳回', '已退款'];
const denied = error => ['FORBIDDEN', 'UNAUTHENTICATED', 'ACCOUNT_DISABLED', 'SESSION_CHANGED'].includes(error?.code);
const errorText = error => error instanceof TradeApiError ? error.message : '操作失败，请重试';

function createOwnerSalesPage({ runtime, wx }) {
  const client = runtime.client;
  let pending = null, writing = false;
  async function authorize() {
    await runtime.assertIdentity();
    if (client.getSession()?.role !== 'owner') throw new TradeApiError('FORBIDDEN');
  }
  return {
    data: { filters: labels, filter: 0, rows: [], cursor: null, loading: false,
      busy: false, pending: false, error: '', notice: '', form: null, reason: '' },
    onShow() {
      this._visit = {};
      this.setData({ busy: writing, pending: Boolean(pending), notice: '' });
      return this.refreshSales();
    },
    onHide() {
      this._visit = null;
      this._query = null;
      this.setData({ rows: [], cursor: null, form: null, reason: '' });
    },
    onUnload() { this.onHide(); pending = null; },
    selectSaleFilter(event) {
      const filter = Number(event.detail.value);
      if (writing || !Number.isInteger(filter) || filter < 0 || filter >= statuses.length) return;
      this.setData({ filter });
      return this.refreshSales();
    },
    refreshSales() {
      this.setData({ rows: [], cursor: null, form: null, reason: '' });
      return this.readSales(null);
    },
    moreSales() {
      if (!writing && !this.data.loading && this.data.cursor) return this.readSales(this.data.cursor);
    },
    async readSales(cursor) {
      if (!this._visit) return;
      const query = this._query = {};
      const current = () => this._visit && this._query === query;
      const status = statuses[this.data.filter];
      this.setData({ loading: true, error: '' });
      try {
        await authorize();
        const result = await client.afterSales.list({ manage: true, limit: 10,
          ...(status ? { status } : {}), ...(cursor ? { cursor } : {}) });
        await authorize();
        if (!current()) return;
        const rows = new Map(this.data.rows.map(row => [row.id, row]));
        for (const row of result.items) rows.set(row._id, {
          id: row._id, orderId: row.orderId, reason: row.reason, reviewReason: row.reviewReason || '',
          version: row.version, status: row.status, statusLabel: labels[statuses.indexOf(row.status)] || '待核对'
        });
        this.setData({ rows: [...rows.values()], cursor: result.nextCursor });
      } catch (error) {
        if (current()) this.showSalesError(error);
      } finally {
        if (current()) this.setData({ loading: false });
      }
    },
    showSalesError(error) {
      if (denied(error)) {
        this._query = null;
        this.setData({ rows: [], cursor: null, form: null, reason: '', loading: false });
      }
      this.setData({ error: errorText(error) });
    },
    openReview(event) {
      const row = this.data.rows.find(item => item.id === event.currentTarget.dataset.id);
      if (!writing && !pending && row?.status === 'REQUESTED') this.setData({ form: row, reason: '', error: '' });
    },
    closeReview() { if (!writing) this.setData({ form: null, reason: '' }); },
    enterReviewReason(event) { if (!writing) this.setData({ reason: event.detail.value }); },
    submitReview(event) {
      const decision = event.currentTarget.dataset.decision;
      const form = this.data.form;
      if (!form || pending || writing || !['approve', 'reject'].includes(decision)) return;
      const reason = this.data.reason.trim();
      if (!reason || reason.length > 200) {
        this.setData({ error: '请输入 1 至 200 字的审核说明。' }); return;
      }
      return this.writeSale({ type: 'review', payload: { afterSaleId: form.id, expectedVersion: form.version, decision, reason } });
    },
    refundSale(event) {
      const row = this.data.rows.find(item => item.id === event.currentTarget.dataset.id);
      if (!pending && !writing && row?.status === 'APPROVED') {
        return this.writeSale({ type: 'refund', payload: { afterSaleId: row.id } });
      }
    },
    retrySaleWrite() { if (pending) return this.writeSale(pending, true); },
    async writeSale(operation, retry = false) {
      const visit = this._visit;
      if (!visit || writing) return;
      const current = () => this._visit === visit;
      const refund = operation.type === 'refund';
      writing = true;
      this.setData({ busy: true, error: '', notice: '' });
      try {
        await authorize();
        if (!current()) return;
        if (!retry) {
          const confirmed = await new Promise((resolve, reject) => wx.showModal({
            title: refund ? '确认整单模拟退款' : operation.payload.decision === 'approve' ? '通过售后审核' : '驳回售后申请',
            content: refund ? '确认后将按原订单金额记录整单模拟退款。' : '请核对审核说明后确认。',
            success: result => resolve(result.confirm === true), fail: reject
          }));
          if (!confirmed || !current()) return;
          await authorize();
          if (!current()) return;
          pending = refund ? operation : { ...operation, payload: { ...operation.payload, requestId: runtime.newCheckoutRequestId() } };
        }
        if (refund) await client.refunds.executeApproved(pending.payload);
        else await client.afterSales.review(pending.payload);
        pending = null;
        await authorize();
        if (!current()) return;
        await this.refreshSales();
        if (current() && !this.data.error) this.setData({ notice: refund ? '模拟退款已完成。' : '审核已保存。' });
      } catch (error) {
        if (!error.uncertain && !denied(error)) pending = null;
        if (current()) {
          if (['VERSION_CONFLICT', 'INVALID_STATE', 'AFTER_SALE_NOT_APPROVED', 'ALREADY_REFUNDED'].includes(error.code)) await this.refreshSales();
          if (current()) {
            if (error.uncertain && pending) this.setData({ error: '结果待核对，请重试原操作。' });
            else this.showSalesError(error);
          }
        }
      } finally {
        writing = false;
        if (this._visit) this.setData({ busy: false, pending: Boolean(pending) });
      }
    }
  };
}

module.exports = { createOwnerSalesPage };
