'use strict';
const { registerMiniappPage } = require('../../services/miniapp-entry');
const { createAddressFormPage } = require('../../services/miniapp-address-form');
registerMiniappPage({ legacy: () => require('./add-address.legacy'), createPage: createAddressFormPage });
