'use strict';
const { registerMiniappPage } = require('../../../services/miniapp-entry');
const { createOwnerSalesPage } = require('../../../services/miniapp-owner-sales');
registerMiniappPage({ legacy: () => ({ onLoad() { wx.navigateBack(); } }), createPage: createOwnerSalesPage });
