'use strict';

if (process.env.NODE_ENV === 'production') {
  module.exports = require('./cjs/react-webmcp-babel.production.js');
} else {
  module.exports = require('./cjs/react-webmcp-babel.development.js');
}
