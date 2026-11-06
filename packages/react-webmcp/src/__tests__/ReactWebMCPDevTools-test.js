/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails react-core
 */

'use strict';

// The renderer injects itself into the DevTools hook when its module loads,
// so the hook has to exist before react-webmcp is required.
const injected = [];
global.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
  supportsFiber: true,
  isDisabled: false,
  inject(internals) {
    injected.push(internals);
    return injected.length;
  },
  checkDCE() {},
  on() {},
  off() {},
  emit() {},
};

const React = require('react');
const Scheduler = require('scheduler');
const {act} = require('internal-test-utils');
const {createFakeModelContext} = require('./utils/createFakeModelContext');

let ReactWebMCP;
let ReactDOMClient;

// The jest host-config setup forks shared/ReactSharedInternals per module
// registry; both renderers must see the same dispatcher slot for hooks. The
// built bundles already share it through the `react` mock below, and the
// build config cannot resolve this source path.
function mockSharedInternals() {
  if (!process.env.IS_BUILD) {
    jest.mock(
      'shared/ReactSharedInternals',
      () =>
        React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE,
    );
  }
}

// Fresh renderers for every test, so each starts with an empty registry: the
// tool renderer first, in its own module registry, then an isolated DOM
// renderer sharing the isomorphic modules.
function loadRenderers() {
  jest.resetModules();
  delete globalThis.__REACT_WEBMCP__;
  jest.mock('scheduler', () => Scheduler);
  jest.mock('react', () => React);
  mockSharedInternals();
  ReactWebMCP = require('react-webmcp');

  jest.resetModules();
  jest.mock('scheduler', () => Scheduler);
  jest.mock('react', () => React);
  mockSharedInternals();
  ReactDOMClient = require('react-dom/client');
}

describe('react-webmcp DevTools integration', () => {
  beforeEach(() => {
    loadRenderers();
  });

  afterAll(() => {
    delete global.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  });

  it('registers itself as a separate renderer', () => {
    const packageNames = injected.map(i => i.rendererPackageName);
    expect(packageNames).toContain('react-webmcp');
  });

  // The registry global that exposes owner tokens is development-only.
  // @gate __DEV__
  // @gate enableWebMCP
  it('keeps host instances identifiable through the fiber stateNode', async () => {
    document.modelContext = createFakeModelContext();
    const container = document.createElement('div');
    const root = ReactDOMClient.createRoot(container);
    function App() {
      return (
        <ReactWebMCP.ToolTree>
          <ReactWebMCP.Tool
            name="add_item"
            description="Add."
            safety="mutate"
            execute={() => 'ok'}
          />
        </ReactWebMCP.ToolTree>
      );
    }
    await act(() => root.render(<App />));
    const internal = global.__REACT_WEBMCP__.getTools();
    expect(internal).toHaveLength(1);
    // The owner token of a tree tool is the host instance itself.
    expect(internal[0].ownerToken.tag).toBe('tool');
    expect(internal[0].ownerToken.props.name).toBe('add_item');
    await act(() => root.unmount());
    delete document.modelContext;
  });
});
