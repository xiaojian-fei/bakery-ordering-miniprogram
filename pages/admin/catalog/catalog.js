'use strict';
const { registerMiniappPage } = require('../../../services/miniapp-entry');
const { createOwnerCatalogPage } = require('../../../services/miniapp-owner-catalog');
registerMiniappPage({ legacy: () => ({ onLoad() { wx.navigateBack(); } }), createPage: createOwnerCatalogPage });
