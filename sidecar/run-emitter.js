'use strict';
function normalizeRunEmitter(value) { return typeof value === 'function' ? value : function () {}; }
module.exports = { normalizeRunEmitter };
