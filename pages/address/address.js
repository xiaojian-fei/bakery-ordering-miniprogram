'use strict';
const { registerMiniappPage } = require('../../services/miniapp-entry');
const { createAddressPage } = require('../../services/miniapp-pages');
registerMiniappPage({ legacy: () => require('./address.legacy'), createPage: createAddressPage });
