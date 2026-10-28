'use strict';
const { TradeApiError } = require('./trade-errors');
const message = error => error instanceof TradeApiError ? error.message : '地址删除未完成，请核对后重试';
const recoveryError = pending => new TradeApiError(pending?.kind === 'remove'
  ? 'ADDRESS_DELETE_RECOVERY_REQUIRED' : 'ADDRESS_RECOVERY_REQUIRED');

function createAddressDeletion({ runtime, wx }) {
  const editor = runtime.addressEditor;
  async function run(page, work) {
    if (!page._active || page._deleting || page.data.loading || page.data.loadingMore) return;
    page._deleting = true; page.setData({ deleteBusy: true, error: '' });
    let attempted = false, error = null;
    try { await work(() => { attempted = true; }); }
    catch (caught) { error = caught; }
    finally {
      try {
        if (page._active) {
          if (attempted) await page.refreshAddresses();
          await page.syncAddressPending();
          if (page._active) {
            if (error) page.setData({ error: message(error) });
            else if (attempted) wx.showToast({ title: '地址已删除', icon: 'success' });
          }
        }
      } finally {
        page._deleting = false;
        if (page._active) page.setData({ deleteBusy: false });
      }
    }
  }
  return {
    async syncAddressPending() {
      if (!this._active) return;
      const epoch = this._pendingEpoch = (this._pendingEpoch || 0) + 1;
      try {
        const pending = await editor.getPending();
        if (this._active && this._pendingEpoch === epoch) this.setData({
          addressWritePending: Boolean(pending && pending.kind !== 'remove'),
          addressDeletePending: pending?.kind === 'remove', deleteBusy: Boolean(this._deleting) });
      } catch (error) {
        if (this._active && this._pendingEpoch === epoch) this.setData({ error: message(error), addresses: [], cursor: null });
      }
    },
    deleteAddress(event) {
      const id = event?.currentTarget?.dataset?.id;
      const item = this.data.addresses.find(address => address._id === id);
      if (!item) return;
      // 确认针对当前展示的版本。确认期间发生编辑时由服务端拒绝旧版本删除。
      const snapshot = { addressId: item._id, expectedVersion: item.version };
      const epoch = this._epoch;
      return run(this, async markAttempted => {
        const pending = await editor.getPending();
        if (!this._active || this._epoch !== epoch) return;
        if (pending) throw recoveryError(pending);
        const confirmed = await new Promise(resolve => {
          try {
            wx.showModal({ title: '删除地址',
              content: '确认删除“' + item.name + '”的这条地址？若它仍为默认地址，将同时取消默认设置；历史订单地址保持不变。',
              confirmText: '删除', confirmColor: '#a32a27',
              success: result => resolve(result.confirm === true), fail: () => resolve(false) });
          } catch (_) { resolve(false); }
        });
        if (!confirmed || !this._active || this._epoch !== epoch) return;
        markAttempted();
        await editor.remove(snapshot);
      });
    },
    retryAddressDelete() {
      return run(this, async markAttempted => {
        const pending = await editor.getPending();
        if (!pending) throw new TradeApiError('INVALID_STATE');
        if (pending.kind !== 'remove') throw recoveryError(pending);
        markAttempted();
        await editor.retryRemove();
      });
    }
  };
}
module.exports = { createAddressDeletion };
