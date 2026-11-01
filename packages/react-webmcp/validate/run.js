/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

'use strict';

require('@babel/register')({
  babelrc: false,
  configFile: false,
  extensions: ['.js'],
  only: [__dirname],
  plugins: [
    // Parse modern Flow syntax (such as `x as T` casts, which this repo's Flow
    // version requires) the same way the rest of the repo does.
    'babel-plugin-syntax-hermes-parser',
    '@babel/plugin-transform-flow-strip-types',
  ],
});

require('./run.flow')
  .main(process.argv.slice(2))
  .then(exitCode => {
    process.exitCode = exitCode;
  })
  .catch(error => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
