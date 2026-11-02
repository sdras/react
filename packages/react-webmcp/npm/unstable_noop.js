'use strict';

if (process.env.NODE_ENV === 'production') {
  module.exports = require('./cjs/react-webmcp-unstable_noop.production.js');
} else {
  module.exports = require('./cjs/react-webmcp-unstable_noop.development.js');
}
