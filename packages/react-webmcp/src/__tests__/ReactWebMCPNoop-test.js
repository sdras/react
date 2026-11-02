/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails react-core
 */

'use strict';

const React = require('react');
const ReactDOMClient = require('react-dom/client');
const {act} = require('internal-test-utils');
const Noop = require('react-webmcp/unstable_noop');
const {createFakeModelContext} = require('./utils/createFakeModelContext');

let container;
let root;
let modelContext;

describe('react-webmcp/unstable_noop', () => {
  beforeEach(() => {
    modelContext = createFakeModelContext();
    document.modelContext = modelContext;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOMClient.createRoot(container);
  });

  afterEach(async () => {
    await act(() => {
      root.unmount();
    });
    container.remove();
    delete document.modelContext;
  });

  it('exports the public surface as no-ops that register nothing', async () => {
    let result = null;
    function App() {
      result = Noop.useWebMCPTool({
        name: 'add_item',
        description: 'Add an item.',
        execute: () => 'never',
      });
      return (
        <Noop.ToolScope name="cart">
          <span>children stay</span>
          <Noop.ToolTree>
            <Noop.Scope name="cart">
              <Noop.Tool name="x" description="y" execute={() => null} />
            </Noop.Scope>
          </Noop.ToolTree>
          <Noop.ToolReview proposals={[]} />
        </Noop.ToolScope>
      );
    }
    await act(() => {
      root.render(<App />);
    });
    expect(container.textContent).toBe('children stay');
    expect(result).toEqual({
      supported: false,
      registered: false,
      error: null,
      qualifiedName: 'add_item',
      available: false,
    });
    expect(modelContext.names()).toEqual([]);
    expect(Noop.unstable_getRegisteredTools()).toEqual([]);
    const unsubscribe = Noop.unstable_subscribeToRegisteredTools(() => {});
    expect(typeof unsubscribe).toBe('function');
    unsubscribe();
  });
});
