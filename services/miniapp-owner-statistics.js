'use strict';
const { TradeApiError } = require('./trade-errors');

const dayMs = 86400000;
const beijingOffset = 8 * 3600000;
const periods = [1, 7, 30];
const date = milliseconds => new Date(milliseconds + beijingOffset).toISOString().slice(0, 10);
const money = cents => (cents / 100).toFixed(2);

function createOwnerStatisticsPage({ runtime, clock = Date.now }) {
  async function authorize() {
    await runtime.assertIdentity();
    if (runtime.client.getSession()?.role !== 'owner') throw new TradeApiError('FORBIDDEN');
  }
  return {
    data: { periods: ['今天', '最近 7 天', '最近 30 天'], period: 0, loading: false, error: '', summary: null },
    onShow() { this._visible = true; return this.loadStatistics(); },
    onHide() { this._visible = false; this._request = null; this.setData({ summary: null }); },
    onUnload() { this.onHide(); },
    changePeriod(event) {
      const period = Number(event.detail.value);
      if (!Number.isInteger(period) || !periods[period]) return;
      this.setData({ period });
      return this.loadStatistics();
    },
    async loadStatistics() {
      if (!this._visible) return;
      const request = this._request = {};
      const current = () => this._visible && this._request === request;
      const now = clock();
      const today = Math.floor((now + beijingOffset) / dayMs) * dayMs - beijingOffset;
      const startAt = today - (periods[this.data.period] - 1) * dayMs;
      const endAt = today + dayMs;
      this.setData({ loading: true, summary: null, error: '' });
      try {
        await authorize();
        const result = await runtime.client.statistics.summary({ startAt, endAt });
        await authorize();
        if (!current()) return;
        if (result?.dataMode !== 'SIMULATED' || result.startAt !== startAt || result.endAt !== endAt
          || ![result.grossCents, result.refundCents, result.netCents, result.paidOrderCount,
            result.refundedOrderCount, result.completedOrderCount].every(Number.isSafeInteger)
          || !Array.isArray(result.productSales)) throw new TradeApiError('PROTOCOL_ERROR');
        this.setData({ summary: {
          start: date(startAt), end: date(endAt - 1), gross: money(result.grossCents),
          refunds: money(result.refundCents), net: money(result.netCents),
          paid: result.paidOrderCount, refunded: result.refundedOrderCount, completed: result.completedOrderCount,
          products: result.productSales.map(({ productId, name, quantity }) => ({ productId, name, quantity }))
            .sort((a, b) => b.quantity - a.quantity || a.productId.localeCompare(b.productId))
        } });
      } catch (error) {
        if (current()) this.setData({ error: error instanceof TradeApiError ? error.message : '统计加载失败，请重试' });
      } finally {
        if (current()) this.setData({ loading: false });
      }
    }
  };
}

module.exports = { createOwnerStatisticsPage };
