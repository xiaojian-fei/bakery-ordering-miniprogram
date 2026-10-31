'use strict';
const { TradeApiError } = require('./trade-errors');
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
const addressFields = ['name', 'phone', 'province', 'city', 'district', 'detail'];
const message = error => error instanceof TradeApiError ? error.message : '收货地址加载失败，请重试';

function createCartAddressSelection({ runtime, wx }) {
  return {
    onDeliveryTypeChange(event) {
      const value = event?.detail?.value;
      if (!['pickup', 'delivery'].includes(value) || value === this.data.deliveryType) return;
      this.invalidateQuote?.();
      this._addressPickerEpoch = (this._addressPickerEpoch || 0) + 1;
      this._addressReadEpoch = (this._addressReadEpoch || 0) + 1;
      this._pickerOpening = false; this._selectedAddressId = null;
      this.setData({ deliveryType: value, selectedAddress: null, addressLoading: false, addressError: '' });
    },
    openAddressPicker() {
      if (!this._active || this._pickerOpening || this.data.deliveryType !== 'delivery') return;
      const epoch = this._addressPickerEpoch = (this._addressPickerEpoch || 0) + 1;
      this._pickerOpening = true;
      let accepted = false;
      wx.navigateTo({ url: '/pages/address/address?selectMode=true',
        events: { addressSelected: value => {
          if (accepted || this._addressDisposed || this._addressPickerEpoch !== epoch
            || this.data.deliveryType !== 'delivery' || !validId(value?.addressId)) return;
          accepted = true;
          this.invalidateQuote?.();
          // 导航返回前购物车通常处于隐藏状态，只暂存ID，onShow再读取完整服务器地址。
          this._selectedAddressId = value.addressId;
          if (this._active) return this.refreshSelectedAddress();
        } },
        fail: () => {
          if (this._addressPickerEpoch !== epoch) return;
          this._pickerOpening = false;
          if (this._active) this.setData({ addressError: '地址列表打开失败，请重试' });
        }
      });
    },
    resumeAddressSelection() {
      this._pickerOpening = false;
      return this.refreshSelectedAddress();
    },
    async refreshSelectedAddress() {
      if (!this._active) return;
      this.invalidateQuote?.();
      const epoch = this._addressReadEpoch = (this._addressReadEpoch || 0) + 1;
      const id = this._selectedAddressId;
      if (this.data.deliveryType !== 'delivery' || !id) {
        this.setData({ selectedAddress: null, addressLoading: false, addressError: '' });
        return;
      }
      this.setData({ selectedAddress: null, addressLoading: true, addressError: '' });
      try {
        const address = await runtime.addressEditor.read(id);
        if (!this._active || this._addressReadEpoch !== epoch) return;
        if (address?._id !== id || !Number.isSafeInteger(address.version) || address.version < 0
          || typeof address.isDefault !== 'boolean' || addressFields.some(field => typeof address[field] !== 'string')) {
          throw new TradeApiError('PROTOCOL_ERROR');
        }
        this.setData({ selectedAddress: { _id: id, version: address.version, isDefault: address.isDefault,
          ...Object.fromEntries(addressFields.map(field => [field, address[field]])) } });
      } catch (error) {
        if (this._active && this._addressReadEpoch === epoch) {
          if (['ADDRESS_NOT_FOUND', 'FORBIDDEN', 'SESSION_CHANGED', 'UNAUTHENTICATED', 'ACCOUNT_DISABLED'].includes(error?.code)) this._selectedAddressId = null;
          this.setData({ selectedAddress: null, addressError: message(error) });
        }
      } finally {
        if (this._active && this._addressReadEpoch === epoch) this.setData({ addressLoading: false });
      }
    },
    disposeAddressSelection() {
      this._addressDisposed = true; this._selectedAddressId = null;
      this._addressPickerEpoch = (this._addressPickerEpoch || 0) + 1;
      this._addressReadEpoch = (this._addressReadEpoch || 0) + 1;
    }
  };
}

function createAddressSelector({ runtime, wx }) {
  return {
    async selectAddress(event) {
      if (!this.data.selectMode || !this._active || this._selecting || this._selectionSent
        || this._deleting || this.data.loading || this.data.loadingMore) return;
      const id = event?.currentTarget?.dataset?.id;
      if (!this.data.addresses.some(item => item._id === id)) return;
      const epoch = this._epoch;
      this._selecting = true; this.setData({ selectionBusy: true, error: '' });
      try {
        const pending = await runtime.addressEditor.getPending();
        if (pending) throw new TradeApiError(pending.kind === 'remove' ? 'ADDRESS_DELETE_RECOVERY_REQUIRED' : 'ADDRESS_RECOVERY_REQUIRED');
        const address = await runtime.addressEditor.read(id);
        if (!this._active || this._epoch !== epoch) return;
        if (address?._id !== id) throw new TradeApiError('PROTOCOL_ERROR');
        const channel = this.getOpenerEventChannel?.();
        if (typeof channel?.emit !== 'function') throw new TradeApiError('ADDRESS_SELECTION_UNAVAILABLE');
        channel.emit('addressSelected', { addressId: id });
        this._selectionSent = true;
        wx.navigateBack({ delta: 1 });
      } catch (error) {
        if (this._active && this._epoch === epoch) this.setData({ error: message(error),
          ...(['SESSION_CHANGED', 'UNAUTHENTICATED', 'ACCOUNT_DISABLED'].includes(error?.code) ? { addresses: [], cursor: null } : {}) });
      } finally {
        this._selecting = false;
        if (this._active) this.setData({ selectionBusy: false });
      }
    }
  };
}
module.exports = { createCartAddressSelection, createAddressSelector };
