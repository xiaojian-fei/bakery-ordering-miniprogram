'use strict';
const { registerMiniappPage } = require('../../../services/miniapp-entry');
const { createOwnerStatisticsPage } = require('../../../services/miniapp-owner-statistics');
registerMiniappPage({ legacy: () => ({ onLoad() { wx.navigateBack(); } }), createPage: createOwnerStatisticsPage });
