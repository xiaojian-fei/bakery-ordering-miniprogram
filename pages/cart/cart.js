'use strict';
const { registerMiniappPage } = require('../../services/miniapp-entry');
const { createCartPage } = require('../../services/miniapp-pages');
registerMiniappPage({ legacy: () => require('./cart.legacy'), createPage: createCartPage });
