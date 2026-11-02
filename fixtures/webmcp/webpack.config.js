'use strict';

const {resolve} = require('path');
const Webpack = require('webpack');

const NODE_ENV = process.env.NODE_ENV || 'development';
const __DEV__ = NODE_ENV === 'development';
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8080);
const isE2E = process.env.E2E === 'true' || process.env.CI === 'true';

// React, react-webmcp and the DevTools backend dependencies are resolved from
// the monorepo build output, the same way react-devtools-shell and the
// react-devtools-cdt-mcp fixture do it. Run `yarn build-for-devtools` from the
// repo root first to populate this folder.
const repoRoot = resolve(__dirname, '..', '..');
const builtModulesDir = resolve(repoRoot, 'build', 'oss-experimental');
const sharedDir = resolve(repoRoot, 'packages', 'react-devtools-shared');

// use-webmcp-tool ships ESM only; resolve it from this fixture's node_modules
// (falling back to the workspace root) so the built react-webmcp bundle and
// the app share one copy.
const useWebMCPToolPath = require.resolve('use-webmcp-tool', {
  paths: [__dirname, repoRoot],
});

module.exports = {
  mode: __DEV__ ? 'development' : 'production',
  // eval-source-map keeps original file names in stack traces, which the
  // validator uses to map a component's source location back to this fixture.
  devtool: isE2E ? 'eval-source-map' : 'cheap-source-map',
  entry: './index.js',
  output: {
    filename: 'bundle.js',
    publicPath: '/dist/',
  },
  node: {
    global: false,
  },
  resolve: {
    alias: {
      react: resolve(builtModulesDir, 'react'),
      'react-debug-tools': resolve(builtModulesDir, 'react-debug-tools'),
      'react-devtools-feature-flags': resolve(
        sharedDir,
        'src',
        'config',
        'DevToolsFeatureFlags.default'
      ),
      'react-dom/client': resolve(builtModulesDir, 'react-dom/client'),
      'react-dom': resolve(builtModulesDir, 'react-dom'),
      'react-is': resolve(builtModulesDir, 'react-is'),
      'react-webmcp': resolve(builtModulesDir, 'react-webmcp'),
      scheduler: resolve(builtModulesDir, 'scheduler'),
      'use-webmcp-tool': useWebMCPToolPath,
    },
  },
  optimization: {
    minimize: false,
  },
  plugins: [
    new Webpack.ProvidePlugin({
      process: 'process/browser',
    }),
    new Webpack.DefinePlugin({
      // Lets the review overlay turn proposal file paths into editor links.
      __WEBMCP_SOURCE_ROOT__: JSON.stringify(resolve(__dirname, 'src')),
      __DEV__,
      __EXPERIMENTAL__: true,
      __EXTENSION__: false,
      __PROFILE__: false,
      __TEST__: false,
      __IS_CHROME__: false,
      __IS_FIREFOX__: false,
      __IS_EDGE__: false,
      __IS_NATIVE__: false,
    }),
  ],
  module: {
    rules: [
      {
        test: /\.js$/,
        exclude: /node_modules\/(?!use-webmcp-tool)/,
        loader: 'babel-loader',
        options: {
          configFile: resolve(sharedDir, 'babel.config.js'),
        },
      },
    ],
  },
  devServer: {
    hot: true,
    host: HOST,
    open: !isE2E,
    port: PORT,
    static: {
      directory: __dirname,
      publicPath: '/',
    },
  },
};
