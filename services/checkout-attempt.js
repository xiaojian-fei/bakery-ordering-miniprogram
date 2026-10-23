'use strict';
const { TradeApiError, copyData, pickData, invalidRequest } = require('./trade-errors');

const freeze = value => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};

// 一次人工确认的结算意图。请求ID由页面为新结算生成，重试不能另起ID或自动改价。
async function prepareCheckout(orders, input, { isCurrent = () => true } = {}) {
  const data = pickData(input, ['requestId', 'items', 'deliveryType', 'addressId', 'remark']);
  if (typeof data.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(data.requestId)) invalidRequest();
  const quote = await orders.quote(pickData(data, ['items', 'deliveryType', 'addressId']));
  if (!isCurrent()) throw new TradeApiError('SESSION_CHANGED');
  if (!quote || !Number.isSafeInteger(quote.totalCents) || quote.totalCents < 1) {
    throw new TradeApiError('PROTOCOL_ERROR');
  }
  const payload = freeze({ ...data, expectedTotalCents: quote.totalCents });
  let inFlight = null;
  let confirmed = null;
  const submit = () => {
    if (!isCurrent()) return Promise.reject(new TradeApiError('SESSION_CHANGED'));
    if (confirmed) return Promise.resolve(copyData(confirmed));
    if (inFlight) return inFlight.then(copyData);
    inFlight = orders.create(payload).then(order => {
      if (!isCurrent()) throw new TradeApiError('SESSION_CHANGED', { uncertain: true });
      if (!order || typeof order._id !== 'string' || order.requestId !== payload.requestId
        || order.amounts?.totalCents !== payload.expectedTotalCents) {
        throw new TradeApiError('PROTOCOL_ERROR', { uncertain: true });
      }
      confirmed = copyData(order);
      return order;
    }).finally(() => { inFlight = null; });
    return inFlight.then(copyData);
  };
  return Object.freeze({ requestId: payload.requestId, quote: freeze(copyData(quote)),
    payload, submit, retry: submit });
}

module.exports = { prepareCheckout };
