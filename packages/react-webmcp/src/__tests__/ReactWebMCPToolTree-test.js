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
const Scheduler = require('scheduler');
const {act, assertConsoleErrorDev} = require('internal-test-utils');
const {createFakeModelContext} = require('./utils/createFakeModelContext');

// Load the tool renderer first so it gets its own reconciler instance.
const ReactWebMCP = require('react-webmcp');
const Registry = require('react-webmcp/src/ReactWebMCPRegistry');
const Validation = require('react-webmcp/src/ReactWebMCPValidation');

// Isolate the DOM renderer, sharing the isomorphic modules.
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

const {ToolTree, Tool, Scope, ToolScope} = ReactWebMCP;

let container;
let root;
let modelContext;

function statuses() {
  return Registry.getRegisteredTools().map(tool => [
    tool.qualifiedName,
    tool.status,
  ]);
}

describe('ToolTree', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.mock('scheduler', () => Scheduler);
    jest.mock('react', () => React);
    // The jest host-config setup forks shared/ReactSharedInternals per module
    // registry; both renderers must see the same dispatcher slot for hooks.
    jest.mock(
      'shared/ReactSharedInternals',
      () =>
        React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE,
    );

    Registry.resetRegistryForTesting();
    Validation.resetReportedIssuesForTesting();
    modelContext = createFakeModelContext();
    document.modelContext = modelContext;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOMClient.createRoot(container);
  });

  afterEach(async () => {
    await act(() => root.unmount());
    document.body.removeChild(container);
    delete document.modelContext;
  });

  it('registers every tool in one pass after the commit, in tree order', async () => {
    function App() {
      return (
        <ToolTree>
          <Scope name="cart">
            <Tool
              name="add_item"
              description="Add an item to the cart."
              safety="mutate"
              execute={() => 'added'}
            />
            <Tool
              name="list_items"
              description="List cart items."
              safety="read"
              execute={() => 'items'}
            />
          </Scope>
          <Tool
            name="checkout"
            description="Start checkout."
            safety="irreversible"
            execute={() => 'checkout'}
          />
        </ToolTree>
      );
    }
    await act(() => root.render(<App />));
    expect(modelContext.log).toEqual([
      ['register', 'cart_add_item'],
      ['register', 'cart_list_items'],
      ['register', 'checkout'],
    ]);
    expect(modelContext.tools.get('cart_list_items').annotations).toEqual({
      readOnlyHint: true,
    });
    expect(modelContext.tools.get('checkout').annotations).toEqual({
      consequentialHint: true,
    });
    expect(
      Registry.getRegisteredTools().map(t => [
        t.qualifiedName,
        t.status,
        t.source,
        t.scopePath,
      ]),
    ).toEqual([
      ['cart_add_item', 'registered', 'tree', ['cart']],
      ['cart_list_items', 'registered', 'tree', ['cart']],
      ['checkout', 'registered', 'tree', []],
    ]);

    await act(() => root.render(null));
    expect(modelContext.names()).toEqual([]);
    expect(statuses()).toEqual([]);
  });

  it('reads the latest execute without re-registering', async () => {
    let setCount;
    function App() {
      const [count, _setCount] = React.useState(0);
      setCount = _setCount;
      return (
        <ToolTree>
          <Tool
            name="read_count"
            description="Read the counter."
            safety="read"
            execute={() => 'count:' + count}
          />
        </ToolTree>
      );
    }
    await act(() => root.render(<App />));
    await act(() => setCount(1));
    await act(() => setCount(2));
    expect(modelContext.registrations()).toEqual(['read_count']);
    expect(await modelContext.executeTool('read_count', {})).toEqual({
      content: [{type: 'text', text: 'count:2'}],
    });
  });

  it('re-registers exactly once when an agent-visible prop changes', async () => {
    function App({description}) {
      return (
        <ToolTree>
          <Tool
            name="read_count"
            description={description}
            safety="read"
            execute={() => 'ok'}
          />
        </ToolTree>
      );
    }
    await act(() => root.render(<App description="First." />));
    await act(() => root.render(<App description="Second." />));
    expect(modelContext.log).toEqual([
      ['register', 'read_count'],
      ['abort', 'read_count'],
      ['register', 'read_count'],
    ]);
    expect(modelContext.tools.get('read_count').description).toBe('Second.');
  });

  it('unregisters only the tools that leave the tree', async () => {
    function App({showSecond}) {
      return (
        <ToolTree>
          <Tool
            name="first"
            description="First."
            safety="read"
            execute={() => 1}
          />
          {showSecond ? (
            <Tool
              name="second"
              description="Second."
              safety="read"
              execute={() => 2}
            />
          ) : null}
        </ToolTree>
      );
    }
    await act(() => root.render(<App showSecond={true} />));
    expect(modelContext.names()).toEqual(['first', 'second']);
    await act(() => root.render(<App showSecond={false} />));
    expect(modelContext.names()).toEqual(['first']);
    expect(modelContext.log).toEqual([
      ['register', 'first'],
      ['register', 'second'],
      ['abort', 'second'],
    ]);
    expect(statuses()).toEqual([['first', 'registered']]);
  });

  it('honors Tool enabled and Scope available', async () => {
    function App({enabled, available}) {
      return (
        <ToolTree>
          <Scope name="cart" available={available}>
            <Tool
              name="add_item"
              description="Add an item."
              safety="mutate"
              enabled={enabled}
              execute={() => 'ok'}
            />
          </Scope>
        </ToolTree>
      );
    }
    await act(() => root.render(<App enabled={false} available={true} />));
    expect(modelContext.names()).toEqual([]);
    expect(statuses()).toEqual([['cart_add_item', 'disabled']]);

    await act(() => root.render(<App enabled={true} available={false} />));
    expect(modelContext.names()).toEqual([]);
    expect(statuses()).toEqual([['cart_add_item', 'unavailable']]);

    await act(() => root.render(<App enabled={true} available={true} />));
    expect(modelContext.names()).toEqual(['cart_add_item']);
    expect(statuses()).toEqual([['cart_add_item', 'registered']]);
  });

  it('carries the DOM tree ToolScope into the tool root', async () => {
    function App({available}) {
      return (
        <ToolScope name="shop" available={available}>
          <ToolTree>
            <Scope name="cart">
              <Tool
                name="add_item"
                description="Add an item."
                safety="mutate"
                execute={() => 'ok'}
              />
            </Scope>
          </ToolTree>
        </ToolScope>
      );
    }
    await act(() => root.render(<App available={true} />));
    expect(modelContext.names()).toEqual(['shop_cart_add_item']);
    expect(Registry.getRegisteredTools()[0].scopePath).toEqual([
      'shop',
      'cart',
    ]);

    await act(() => root.render(<App available={false} />));
    expect(modelContext.names()).toEqual([]);
    expect(statuses()).toEqual([['shop_cart_add_item', 'unavailable']]);
  });

  it('unregisters tools hidden by a Suspense boundary inside the tree', async () => {
    let resolvePromise;
    const promise = new Promise(resolve => {
      resolvePromise = resolve;
    });
    let resolved = false;
    function Suspender({suspend}) {
      if (suspend && !resolved) {
        throw promise;
      }
      return null;
    }
    function App({suspend}) {
      return (
        <ToolTree>
          <Tool
            name="always"
            description="Always."
            safety="read"
            execute={() => 1}
          />
          <React.Suspense fallback={null}>
            <Scope name="cart">
              <Tool
                name="add_item"
                description="Add an item."
                safety="mutate"
                execute={() => 'ok'}
              />
            </Scope>
            <Suspender suspend={suspend} />
          </React.Suspense>
        </ToolTree>
      );
    }
    await act(() => root.render(<App suspend={false} />));
    expect(modelContext.names()).toEqual(['always', 'cart_add_item']);

    await act(() => root.render(<App suspend={true} />));
    expect(modelContext.names()).toEqual(['always']);
    expect(statuses()).toEqual([
      ['always', 'registered'],
      ['cart_add_item', 'unavailable'],
    ]);

    await act(async () => {
      resolved = true;
      resolvePromise();
      await promise;
    });
    expect(modelContext.names()).toEqual(['always', 'cart_add_item']);
    expect(modelContext.registrations()).toEqual([
      'always',
      'cart_add_item',
      'cart_add_item',
    ]);
  });

  it('unregisters everything while a DOM Suspense boundary hides the ToolTree', async () => {
    let resolvePromise;
    const promise = new Promise(resolve => {
      resolvePromise = resolve;
    });
    let resolved = false;
    function Suspender({suspend}) {
      if (suspend && !resolved) {
        throw promise;
      }
      return null;
    }
    function App({suspend}) {
      return (
        <React.Suspense fallback="loading">
          <ToolTree>
            <Tool
              name="add_item"
              description="Add."
              safety="mutate"
              execute={() => 'ok'}
            />
          </ToolTree>
          <Suspender suspend={suspend} />
        </React.Suspense>
      );
    }
    await act(() => root.render(<App suspend={false} />));
    expect(modelContext.names()).toEqual(['add_item']);

    await act(() => root.render(<App suspend={true} />));
    expect(container.textContent).toBe('loading');
    expect(modelContext.names()).toEqual([]);
    expect(statuses()).toEqual([]);

    await act(async () => {
      resolved = true;
      resolvePromise();
      await promise;
    });
    expect(modelContext.names()).toEqual(['add_item']);
    expect(statuses()).toEqual([['add_item', 'registered']]);
  });

  it('records an error when registration is refused synchronously', async () => {
    modelContext = createFakeModelContext({failFor: 'refused'});
    document.modelContext = modelContext;
    function App() {
      return (
        <ToolTree>
          <Tool
            name="refused"
            description="Refused."
            safety="read"
            execute={() => 1}
          />
          <Tool
            name="fine"
            description="Fine."
            safety="read"
            execute={() => 1}
          />
        </ToolTree>
      );
    }
    await act(() => root.render(<App />));
    expect(modelContext.names()).toEqual(['fine']);
    const refused = Registry.getRegisteredTools().find(
      t => t.qualifiedName === 'refused',
    );
    expect(refused.status).toBe('error');
    expect(refused.error).toBe('Registration refused for refused');
  });

  it('records an error when registration rejects asynchronously', async () => {
    modelContext = createFakeModelContext({rejectFor: 'refused'});
    document.modelContext = modelContext;
    function App() {
      return (
        <ToolTree>
          <Tool
            name="refused"
            description="Refused."
            safety="read"
            execute={() => 1}
          />
        </ToolTree>
      );
    }
    await act(() => root.render(<App />));
    await act(async () => {
      await Promise.resolve();
    });
    const refused = Registry.getRegisteredTools()[0];
    expect(refused.status).toBe('error');
    expect(refused.error).toBe('Async registration refused for refused');
  });

  it('marks invalid tool definitions as errors without registering them', async () => {
    function App() {
      return (
        <ToolTree>
          <Tool
            name="no_execute"
            description="Missing execute."
            safety="read"
          />
        </ToolTree>
      );
    }
    await act(() => root.render(<App />));
    assertConsoleErrorDev(
      [
        'react-webmcp: A <Tool> needs a name, a description, and an execute ' +
          'function. It was not registered. Received name="no_execute".',
      ],
      {withoutStack: true},
    );
    expect(modelContext.names()).toEqual([]);
    expect(statuses()).toEqual([['no_execute', 'error']]);
  });

  it('rejects text children with a helpful error', async () => {
    function App() {
      return <ToolTree>not a tool</ToolTree>;
    }
    await expect(act(() => root.render(<App />))).rejects.toThrow(
      'react-webmcp: Text is not allowed inside a <ToolTree>.',
    );
  });

  it('reports unsupported without touching the browser when modelContext is missing', async () => {
    delete document.modelContext;
    function App() {
      return (
        <ToolTree>
          <Tool
            name="add_item"
            description="Add."
            safety="mutate"
            execute={() => 'ok'}
          />
        </ToolTree>
      );
    }
    await act(() => root.render(<App />));
    expect(statuses()).toEqual([['add_item', 'unsupported']]);
  });

  it('uses id as the registry key and keeps one registration under StrictMode', async () => {
    function App() {
      return (
        <React.StrictMode>
          <ToolTree>
            <Tool
              id="cart:add"
              name="add_item"
              description="Add."
              safety="mutate"
              execute={() => 'ok'}
            />
          </ToolTree>
        </React.StrictMode>
      );
    }
    await act(() => root.render(<App />));
    expect(modelContext.names()).toEqual(['add_item']);
    expect(Registry.getRegisteredTools().map(t => t.key)).toEqual(['cart:add']);
  });

  it('normalizes execute results and errors like the hook', async () => {
    const seen = [];
    function App() {
      return (
        <ToolTree>
          <Tool
            name="text"
            description="Text."
            safety="read"
            execute={() => 'hello'}
          />
          <Tool
            name="object"
            description="Object."
            safety="read"
            execute={() => ({a: 1})}
          />
          <Tool
            name="nothing"
            description="Nothing."
            safety="read"
            execute={() => undefined}
          />
          <Tool
            name="throws"
            description="Throws."
            safety="read"
            onError={error => seen.push(error)}
            execute={() => {
              // eslint-disable-next-line no-throw-literal
              throw 'not signed in';
            }}
          />
          <Tool
            name="formatted"
            description="Formatted."
            safety="read"
            formatOutput={(result, input) =>
              'formatted:' + result + ':' + input.q
            }
            execute={({q}) => q.toUpperCase()}
          />
        </ToolTree>
      );
    }
    await act(() => root.render(<App />));
    expect(await modelContext.executeTool('text', {})).toEqual({
      content: [{type: 'text', text: 'hello'}],
    });
    expect(await modelContext.executeTool('object', {})).toEqual({
      content: [{type: 'text', text: '{"a":1}'}],
    });
    expect(await modelContext.executeTool('nothing', {})).toEqual({
      content: [],
    });
    expect(await modelContext.executeTool('throws', {})).toEqual({
      content: [{type: 'text', text: 'not signed in'}],
      isError: true,
    });
    expect(seen).toEqual(['not signed in']);
    expect(await modelContext.executeTool('formatted', {q: 'abc'})).toEqual({
      content: [{type: 'text', text: 'formatted:ABC:abc'}],
    });
  });
});
