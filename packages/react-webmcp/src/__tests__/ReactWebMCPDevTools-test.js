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

const ReactWebMCP = require('react-webmcp');

jest.resetModules();
jest.mock('scheduler', () => Scheduler);
jest.mock('react', () => React);
// The jest host-config setup forks shared/ReactSharedInternals per module
// registry; both renderers must see the same dispatcher slot for hooks.
jest.mock(
  'shared/ReactSharedInternals',
  () => React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE,
);
const ReactDOMClient = require('react-dom/client');

describe('react-webmcp DevTools integration', () => {
  afterAll(() => {
    delete global.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  });

  it('registers itself as a separate renderer', () => {
    const packageNames = injected.map(i => i.rendererPackageName);
    expect(packageNames).toContain('react-webmcp');
  });

  // The registry global that exposes owner tokens is development-only.
  // @gate __DEV__
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
