'use strict';
const { registerMiniappPage } = require('../../services/miniapp-entry');
const { createStaffLoginPage } = require('../../services/miniapp-staff');
registerMiniappPage({ legacy: () => require('./admin-login.legacy'), createPage: createStaffLoginPage });
