'use strict';
const { registerMiniappPage } = require('../../services/miniapp-entry');
const { createStaffOrdersPage } = require('../../services/miniapp-staff');
registerMiniappPage({ legacy: () => require('./admin.legacy'), createPage: createStaffOrdersPage });
