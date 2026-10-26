'use strict';

// 页面使用本地文案，不显示原始网络异常、响应正文、口令或令牌。
const hints = Object.freeze({
  UNAUTHENTICATED: ['登录状态已失效，请重新登录', 'login'],
  SESSION_CHANGED: ['登录状态已变化，请重新操作', 'login'],
  AUTH_FAILED: ['身份或口令不正确', 'edit'],
  AUTH_LOCKED: ['登录失败次数过多，请稍后重试', 'wait'],
  AUTH_RETRY: ['账号配置已变化，请重新登录', 'login'],
  ACCOUNT_DISABLED: ['账号已停用，请联系店主', 'contact'],
  FORBIDDEN: ['当前身份没有此操作权限', 'contact'],
  PRICE_CHANGED: ['价格或运费已变化，请重新确认', 'requote'],
  OUT_OF_STOCK: ['商品可售库存不足，请调整数量', 'edit'],
  PRODUCT_UNAVAILABLE: ['商品已下架，请重新选择', 'edit'],
  PRODUCT_NOT_FOUND: ['商品不存在，请刷新列表', 'refresh'],
  VERSION_CONFLICT: ['数据已更新，请刷新后重新确认', 'refresh'],
  IDEMPOTENCY_CONFLICT: ['重试参数与原请求不同，请核对原操作', 'review'],
  INVALID_STATE: ['当前订单状态不允许此操作，请刷新', 'refresh'],
  ORDER_EXPIRED: ['订单支付时间已截止，请刷新订单', 'refresh'],
  ORDER_NOT_FOUND: ['订单不存在，请刷新列表', 'refresh'],
  INVALID_ADDRESS: ['收货地址无效，请重新选择', 'edit'],
  INVALID_REQUEST: ['提交内容不合法，请检查后重试', 'edit'],
  INVALID_ITEMS: ['请选择有效商品', 'edit'],
  INVALID_QUANTITY: ['商品数量需为1～99的整数', 'edit'],
  INVALID_AMOUNT: ['金额格式不合法，请重新确认', 'edit'],
  INVALID_DELIVERY: ['配送方式不合法，请重新选择', 'edit'],
  INVALID_PASSWORD: ['口令不符合要求，请重新填写', 'edit'],
  RESERVED_STOCK_CONFLICT: ['实物库存不能低于已预留数量', 'refresh'],
  AFTER_SALE_NOT_APPROVED: ['售后尚未通过审核，请刷新', 'refresh'],
  ALREADY_REFUNDED: ['订单已完成整单退款，请刷新', 'refresh'],
  ADDRESS_NOT_FOUND: ['地址不存在或已删除，请重新选择', 'edit'],
  INVALID_CURSOR: ['分页条件已变化，请刷新列表', 'refresh'],
  AFTER_SALE_EXISTS: ['订单已有处理中售后，请查看进度', 'refresh'],
  AFTER_SALE_NOT_FOUND: ['售后记录不存在，请刷新', 'refresh'],
  AFTER_SALE_PENDING: ['售后已批准，等待退款处理', 'refresh'],
  INVALID_PICKUP_CODE: ['自取核销码不正确或已使用', 'edit'],
  REPORT_TOO_LARGE: ['数据量过大，请缩小统计日期范围', 'edit'],
  INVALID_CHECKOUT_DRAFT: ['结算草稿已损坏，请核对订单后重新准备', 'review'],
  CHECKOUT_STORAGE_ERROR: ['结算草稿无法保存，请检查本地存储', 'review'],
  CHECKOUT_RECOVERY_REQUIRED: ['有结果未确认的结算，请先找回或核对原订单', 'check_then_retry'],
  CHECKOUT_IDENTITY_MISMATCH: ['结算草稿与当前身份不一致，请切回原账号', 'login'],
  STALE_CHECKOUT_DRAFT: ['这份结算已被新的草稿替换，请重新查看', 'refresh'],
  NETWORK_ERROR: ['连接中断，操作结果可能尚未确认，请先核对再重试', 'check_then_retry'],
  PROTOCOL_ERROR: ['服务响应异常，请先核对操作结果', 'check_then_retry'],
  INTERNAL_ERROR: ['服务暂不可用，请稍后重试', 'wait']
});

class TradeApiError extends Error {
  constructor(code, { uncertain = false } = {}) {
    const hint = Object.prototype.hasOwnProperty.call(hints, code) ? hints[code] : ['操作未完成，请核对数据或联系负责人', 'review'];
    super(hint[0]);
    this.name = 'TradeApiError';
    this.code = code;
    this.recovery = hint[1];
    this.uncertain = uncertain;
  }
}

function invalidRequest() { throw new TradeApiError('INVALID_REQUEST'); }

// 限定为可传输的数据副本，避免调用方在等待网络时改写同一请求对象。
function copyData(value) {
  try {
    const text = JSON.stringify(value, (key, entry) => {
      if (['undefined', 'function', 'symbol', 'bigint'].includes(typeof entry)
        || (typeof entry === 'number' && !Number.isFinite(entry))) invalidRequest();
      return entry;
    });
    if (typeof text !== 'string' || text.length > 32768) invalidRequest();
    return JSON.parse(text);
  } catch (_) { return invalidRequest(); }
}

function pickData(input, fields) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalidRequest();
  const data = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(input, field) && input[field] !== undefined) data[field] = input[field];
  }
  return copyData(data);
}

module.exports = { TradeApiError, copyData, pickData, invalidRequest };
