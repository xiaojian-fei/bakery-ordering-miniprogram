'use strict';
const { registerMiniappPage } = require('../../services/miniapp-entry');
registerMiniappPage({ legacy: () => require('./orders.legacy') });
