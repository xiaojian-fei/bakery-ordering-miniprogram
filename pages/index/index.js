'use strict';
const { registerMiniappPage } = require('../../services/miniapp-entry');
const { createCatalogPage } = require('../../services/miniapp-pages');
registerMiniappPage({ legacy: () => require('./index.legacy'), createPage: createCatalogPage });
