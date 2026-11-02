/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails react-core
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const babel = require('@babel/core');

const plugin = require('react-webmcp/babel').default;
const {isWebMCPEnabledFor} = require('react-webmcp/src/ReactWebMCPBabelPlugin');

const SOURCE = [
  "import {useWebMCPTool, ToolTree} from 'react-webmcp';",
  "import {ToolReview} from 'react-webmcp/unstable_review';",
  "import React from 'react';",
  "export {ToolScope} from 'react-webmcp';",
  "export * from 'react-webmcp/unstable_review';",
  "const lazy = () => import('react-webmcp');",
  "const legacy = require('react-webmcp');",
  'function shadowed(require) {',
  "  return require('react-webmcp');",
  '}',
].join('\n');

function transform(code, options, filename) {
  return babel.transformSync(code, {
    babelrc: false,
    configFile: false,
    filename: filename || '/project/src/App.js',
    plugins: [options === undefined ? plugin : [plugin, options]],
  }).code;
}

function sources(code) {
  return Array.from(
    code.matchAll(/['"]((?:react|react-webmcp)[^'"]*)['"]/g),
  ).map(match => match[1]);
}

let tmp;

describe('react-webmcp/babel', () => {
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'react-webmcp-babel-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, {recursive: true, force: true});
  });

  it('points every react-webmcp import at the no-op module when disabled', () => {
    const code = transform(SOURCE, {enabled: false});
    expect(sources(code)).toEqual([
      'react-webmcp/unstable_noop',
      'react-webmcp/unstable_noop',
      'react',
      'react-webmcp/unstable_noop',
      'react-webmcp/unstable_noop',
      'react-webmcp/unstable_noop',
      'react-webmcp/unstable_noop',
      // A local `require` binding is not Node's require.
      'react-webmcp',
    ]);
  });

  it('leaves the code alone when enabled', () => {
    const code = transform(SOURCE, {enabled: true});
    expect(sources(code)).toEqual([
      'react-webmcp',
      'react-webmcp/unstable_review',
      'react',
      'react-webmcp',
      'react-webmcp/unstable_review',
      'react-webmcp',
      'react-webmcp',
      'react-webmcp',
    ]);
  });

  it('reads the opt-in flag from the nearest package.json that has it', () => {
    const app = path.join(tmp, 'packages', 'app');
    fs.mkdirSync(path.join(app, 'src'), {recursive: true});
    const file = path.join(app, 'src', 'App.js');

    // No package.json anywhere: WebMCP is opt-in, so it is off.
    expect(sources(transform(SOURCE, undefined, file))).toContain(
      'react-webmcp/unstable_noop',
    );

    // A workspace root that opts in covers its packages.
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({name: 'workspace', webmcp: {enabled: true}}),
    );
    fs.writeFileSync(
      path.join(app, 'package.json'),
      JSON.stringify({name: 'app'}),
    );
    expect(sources(transform(SOURCE, undefined, file))).not.toContain(
      'react-webmcp/unstable_noop',
    );

    // The nearest package.json that mentions webmcp wins.
    fs.writeFileSync(
      path.join(app, 'package.json'),
      JSON.stringify({name: 'app', webmcp: false}),
    );
    expect(sources(transform(SOURCE, undefined, file))).toContain(
      'react-webmcp/unstable_noop',
    );
    fs.writeFileSync(
      path.join(app, 'package.json'),
      JSON.stringify({name: 'app', webmcp: true}),
    );
    expect(sources(transform(SOURCE, undefined, file))).not.toContain(
      'react-webmcp/unstable_noop',
    );

    // `root` points the lookup somewhere else (here, at a directory that
    // opts out even though the workspace root opts in).
    const elsewhere = path.join(tmp, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(
      path.join(elsewhere, 'package.json'),
      JSON.stringify({name: 'elsewhere', webmcp: false}),
    );
    expect(sources(transform(SOURCE, {root: elsewhere}, file))).toContain(
      'react-webmcp/unstable_noop',
    );
  });

  it('caches the lookup per directory and treats bad JSON as unset', () => {
    fs.writeFileSync(path.join(tmp, 'package.json'), '{not json');
    const cache = new Map();
    expect(isWebMCPEnabledFor(tmp, cache)).toBe(false);
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({webmcp: true}),
    );
    // Still cached from the first lookup.
    expect(isWebMCPEnabledFor(tmp, cache)).toBe(false);
    expect(isWebMCPEnabledFor(tmp, new Map())).toBe(true);
  });
});
