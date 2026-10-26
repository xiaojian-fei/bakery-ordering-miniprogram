'use strict';
const { registerMiniappPage } = require('../../services/miniapp-entry');
const { createDetailPage } = require('../../services/miniapp-pages');
registerMiniappPage({ legacy: () => require('./detail.legacy'), createPage: createDetailPage });
