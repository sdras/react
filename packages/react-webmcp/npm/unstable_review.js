'use strict';

if (process.env.NODE_ENV === 'production') {
  module.exports = require('./cjs/react-webmcp-unstable_review.production.js');
} else {
  module.exports = require('./cjs/react-webmcp-unstable_review.development.js');
}
