'use strict';
const { registerMiniappPage } = require('../../../services/miniapp-entry');
const { createOwnerShopPage } = require('../../../services/miniapp-owner-shop');
registerMiniappPage({ legacy: () => ({ onLoad() { wx.navigateBack(); } }), createPage: createOwnerShopPage });
