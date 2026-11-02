/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

'use strict';

const path = require('path');

require('@babel/register')({
  babelrc: false,
  configFile: false,
  extensions: ['.js'],
  // The CLI's own modules plus the validator helpers that `trace` reuses.
  only: [__dirname, path.join(__dirname, '..', 'validate')],
  plugins: [
    // Parse modern Flow syntax (such as `x as T` casts, which this repo's Flow
    // version requires) the same way the rest of the repo does.
    'babel-plugin-syntax-hermes-parser',
    '@babel/plugin-transform-flow-strip-types',
  ],
});

require('./cli.flow')
  .main(process.argv.slice(2))
  .then(exitCode => {
    process.exitCode = exitCode;
  })
  .catch(error => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
