'use strict';
const { registerMiniappPage } = require('../../services/miniapp-entry');
const { createOrdersPage } = require('../../services/miniapp-orders');
registerMiniappPage({ legacy: () => require('./orders.legacy'), createPage: createOrdersPage });
