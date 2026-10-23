'use strict';

class BusinessError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BusinessError';
    this.code = code;
  }
}

function ensure(condition, code, message) {
  if (!condition) throw new BusinessError(code, message);
}

module.exports = { BusinessError, ensure };
