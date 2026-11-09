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

let ReactDOM;
let ReactDOMClient;
let ToolTree;
let Tool;
let Scope;
let ToolScope;
let useWebMCPTool;
let unstable_getRegisteredTools;
let unstable_subscribeToRegisteredTools;

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

// Fresh renderers for every test, so each starts with an empty registry and
// no remembered warnings. The tool renderer loads first so it gets its own
// reconciler instance, together with the react-dom it registers itself with
// (the registry is read through that react-dom's public API, which is all
// the built bundles expose). The DOM renderer is then isolated in a second
// module registry, sharing the isomorphic modules.
function loadRenderers() {
  jest.resetModules();
  delete globalThis.__REACT_WEBMCP__;
  jest.mock('scheduler', () => Scheduler);
  jest.mock('react', () => React);
  mockSharedInternals();
  ({
    ToolTree,
    Tool,
    Scope,
    ToolScope,
    useWebMCPTool,
    unstable_getRegisteredTools,
    unstable_subscribeToRegisteredTools,
  } = require('react-webmcp'));
  ReactDOM = require('react-dom');

  jest.resetModules();
  jest.mock('scheduler', () => Scheduler);
  jest.mock('react', () => React);
  mockSharedInternals();
  ReactDOMClient = require('react-dom/client');
}

let container;
let root;
let modelContext;

function statuses() {
  return ReactDOM.unstable_getWebMCPTools().map(tool => [
    tool.qualifiedName,
    tool.status,
  ]);
}

describe('ToolTree', () => {
  beforeEach(() => {
    loadRenderers();

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

  // @gate enableWebMCP
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
      ReactDOM.unstable_getWebMCPTools().map(t => [
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

  // @gate enableWebMCP
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

  // @gate enableWebMCP
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

  // @gate enableWebMCP
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

  // @gate enableWebMCP
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

  // @gate enableWebMCP
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
    expect(ReactDOM.unstable_getWebMCPTools()[0].scopePath).toEqual([
      'shop',
      'cart',
    ]);

    await act(() => root.render(<App available={false} />));
    expect(modelContext.names()).toEqual([]);
    expect(statuses()).toEqual([['shop_cart_add_item', 'unavailable']]);
  });

  // @gate enableWebMCP
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

  // @gate enableWebMCP
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

  // @gate enableWebMCP
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
    const refused = ReactDOM.unstable_getWebMCPTools().find(
      t => t.qualifiedName === 'refused',
    );
    expect(refused.status).toBe('error');
    expect(refused.error).toBe('Registration refused for refused');
  });

  // @gate enableWebMCP
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
    const refused = ReactDOM.unstable_getWebMCPTools()[0];
    expect(refused.status).toBe('error');
    expect(refused.error).toBe('Async registration refused for refused');
  });

  // @gate enableWebMCP
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

  // @gate enableWebMCP
  it('rejects text children with a helpful error', async () => {
    function App() {
      return <ToolTree>not a tool</ToolTree>;
    }
    await expect(act(() => root.render(<App />))).rejects.toThrow(
      'react-webmcp: Text is not allowed inside a <ToolTree>.',
    );
  });

  // @gate enableWebMCP
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

  // @gate enableWebMCP
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
    expect(ReactDOM.unstable_getWebMCPTools().map(t => t.key)).toEqual([
      'cart:add',
    ]);
  });

  // @gate enableWebMCP
  it('keeps the record of a tool React replaced in one commit', async () => {
    function App({version}) {
      return (
        <ToolTree>
          <Tool
            key={version}
            name="add_item"
            description="Add."
            safety="mutate"
            execute={() => version}
          />
        </ToolTree>
      );
    }
    await act(() => root.render(<App version={1} />));
    await act(() => root.render(<App version={2} />));
    // The old host instance left the tree and the new one took its place in
    // the same commit; the record and the registration belong to the new one.
    expect(statuses()).toEqual([['add_item', 'registered']]);
    expect(modelContext.log).toEqual([
      ['register', 'add_item'],
      ['abort', 'add_item'],
      ['register', 'add_item'],
    ]);
    expect(await modelContext.executeTool('add_item', {})).toEqual({
      content: [{type: 'text', text: '2'}],
    });
  });

  // @gate enableWebMCP
  it('shares one registry and one scope with the hook in react-dom', async () => {
    function HookTool() {
      ReactDOM.unstable_useWebMCPTool({
        name: 'list_todos',
        description: 'List todos.',
        safety: 'read',
        execute: () => 'todos',
      });
      return null;
    }
    function App() {
      return (
        <ToolScope name="shop">
          <HookTool />
          <ToolTree>
            <Tool
              name="add_item"
              description="Add an item."
              safety="mutate"
              execute={() => 'ok'}
            />
          </ToolTree>
        </ToolScope>
      );
    }
    await act(() => root.render(<App />));
    expect(modelContext.names()).toEqual(['shop_add_item', 'shop_list_todos']);
    expect(
      ReactDOM.unstable_getWebMCPTools()
        .map(t => [t.qualifiedName, t.source, t.status])
        .sort(),
    ).toEqual([
      ['shop_add_item', 'tree', 'registered'],
      ['shop_list_todos', 'hook', 'registered'],
    ]);
    await act(() => root.render(null));
    expect(modelContext.names()).toEqual([]);
    expect(statuses()).toEqual([]);
  });

  // @gate enableWebMCP
  it('warns when two tools in the tree share a key, once the commit settles', async () => {
    const collisionMessage =
      'Two components registered a WebMCP tool named "add_item" without ' +
      'distinct keys. Agents cannot tell them apart, and developer tooling ' +
      'only keeps the most recent one. Give them distinct names, wrap one ' +
      'in <Scope name> to prefix it, or set a unique `id` on each <Tool>.';
    function App({showSecond}) {
      return (
        <ToolTree>
          <Tool
            name="add_item"
            description="Add."
            safety="mutate"
            execute={() => 1}
          />
          {showSecond ? (
            <Tool
              name="add_item"
              description="Add again."
              safety="mutate"
              execute={() => 2}
            />
          ) : null}
        </ToolTree>
      );
    }
    await act(() => root.render(<App showSecond={false} />));
    await act(() => root.render(<App showSecond={true} />));
    // Reported from <ToolTree>'s passive effect, after the DOM commit.
    assertConsoleErrorDev([collisionMessage + '\n    in App (at **)']);
    expect(statuses()).toEqual([['add_item', 'registered']]);
  });

  // @gate enableWebMCP
  it('warns when two tools in the tree share an agent-facing name under distinct ids', async () => {
    function App() {
      return (
        <ToolTree>
          <Tool
            id="first"
            name="add_item"
            description="Add."
            safety="mutate"
            execute={() => 1}
          />
          <Tool
            id="second"
            name="add_item"
            description="Add again."
            safety="mutate"
            execute={() => 2}
          />
        </ToolTree>
      );
    }
    await act(() => root.render(<App />));
    assertConsoleErrorDev(
      [
        'Two WebMCP tools are registered with the name "add_item". Agents ' +
          'cannot tell them apart. Give them distinct names, or wrap one in ' +
          '<Scope name> to prefix it.',
      ],
      {withoutStack: true},
    );
  });

  // Every record a commit touches is written under one registry batch, so
  // developer tooling subscribed to the registry hears about a commit once.
  // @gate enableWebMCP
  it('notifies registry subscribers once per commit', async () => {
    const snapshots = [];
    const unsubscribe = ReactDOM.unstable_subscribeToWebMCPTools(() => {
      snapshots.push(statuses());
    });
    function App({count}) {
      const tools = [];
      for (let i = 0; i < count; i++) {
        tools.push(
          <Tool
            key={i}
            name={'tool_' + i}
            description="Tool."
            safety="read"
            execute={() => i}
          />,
        );
      }
      return <ToolTree>{tools}</ToolTree>;
    }
    await act(() => root.render(<App count={3} />));
    expect(snapshots).toEqual([
      [
        ['tool_0', 'registered'],
        ['tool_1', 'registered'],
        ['tool_2', 'registered'],
      ],
    ]);
    snapshots.length = 0;
    await act(() => root.render(<App count={1} />));
    expect(snapshots).toEqual([[['tool_0', 'registered']]]);
    unsubscribe();
  });

  // @gate enableWebMCP
  it('does not warn when a hook tool is replaced by a tree tool in one commit', async () => {
    function HookTool() {
      ReactDOM.unstable_useWebMCPTool({
        name: 'add_item',
        description: 'Add.',
        safety: 'mutate',
        execute: () => 'hook',
      });
      return null;
    }
    function App({useTree}) {
      return useTree ? (
        <ToolTree>
          <Tool
            name="add_item"
            description="Add."
            safety="mutate"
            execute={() => 'tree'}
          />
        </ToolTree>
      ) : (
        <HookTool />
      );
    }
    await act(() => root.render(<App useTree={false} />));
    expect(statuses()).toEqual([['add_item', 'registered']]);
    // The hook's hidden record is still there while the tool root commits
    // inside this DOM commit; it is gone by the time the check runs.
    await act(() => root.render(<App useTree={true} />));
    expect(
      ReactDOM.unstable_getWebMCPTools().map(t => [t.qualifiedName, t.source]),
    ).toEqual([['add_item', 'tree']]);
    expect(await modelContext.executeTool('add_item', {})).toEqual({
      content: [{type: 'text', text: 'tree'}],
    });
  });

  // @gate enableWebMCP
  it('passes execute a signal that aborts when the tool is hidden or removed', async () => {
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
    let seenSignal = null;
    function App({suspend}) {
      return (
        <ToolTree>
          <React.Suspense fallback={null}>
            <Tool
              name="slow"
              description="Slow."
              safety="read"
              execute={(input, {signal}) => {
                seenSignal = signal;
                return 'started';
              }}
            />
            <Suspender suspend={suspend} />
          </React.Suspense>
        </ToolTree>
      );
    }
    await act(() => root.render(<App suspend={false} />));
    await modelContext.executeTool('slow', {});
    expect(seenSignal).not.toBe(null);
    expect(seenSignal.aborted).toBe(false);

    await act(() => root.render(<App suspend={true} />));
    expect(seenSignal.aborted).toBe(true);

    await act(async () => {
      resolved = true;
      resolvePromise();
      await promise;
    });
    await modelContext.executeTool('slow', {});
    expect(seenSignal.aborted).toBe(false);

    await act(() => root.render(null));
    expect(seenSignal.aborted).toBe(true);
  });

  // @gate enableWebMCP
  it('does not re-walk the tree when a parent re-renders with inline schema objects', async () => {
    let flushes = 0;
    const target = () => {
      flushes++;
      return modelContext;
    };
    function App({count, description}) {
      return (
        <ToolTree target={target}>
          <Tool
            name="read_count"
            description={description}
            safety="read"
            inputSchema={{type: 'object', properties: {}}}
            annotations={{readOnlyHint: true}}
            execute={() => count}
          />
        </ToolTree>
      );
    }
    await act(() => root.render(<App count={0} description="Read." />));
    expect(flushes).toBe(1);
    await act(() => root.render(<App count={1} description="Read." />));
    await act(() => root.render(<App count={2} description="Read." />));
    // Same content, new identities: nothing the agent sees changed.
    expect(flushes).toBe(1);
    expect(modelContext.registrations()).toEqual(['read_count']);
    expect(await modelContext.executeTool('read_count', {})).toEqual({
      content: [{type: 'text', text: '2'}],
    });
    // A change the agent can see still goes through, once.
    await act(() =>
      root.render(<App count={3} description="Read the counter." />),
    );
    expect(flushes).toBe(2);
    expect(modelContext.registrations()).toEqual(['read_count', 'read_count']);
  });

  // @gate enableWebMCP
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
  // A react-dom built without enableWebMCP exports the hook path as
  // undefined. The package then stands in with no-ops, so an app on such a
  // build (stable, canary) renders and registers nothing, and DEV says why
  // once, instead of the first useWebMCPTool call throwing a TypeError.
  // @gate !enableWebMCP
  it('registers nothing and warns once when react-dom was built without the flag', async () => {
    expect(ReactDOM.unstable_useWebMCPTool).toBe(undefined);
    let result;
    function HookTool() {
      result = useWebMCPTool({
        name: 'add_todo',
        description: 'Add a todo.',
        safety: 'mutate',
        execute: () => 'ok',
      });
      return 'hook';
    }
    function App() {
      return (
        <ToolScope name="shop">
          <HookTool />
          <ToolTree>
            <Tool
              name="add_item"
              description="Add an item."
              safety="mutate"
              execute={() => 'ok'}
            />
          </ToolTree>
        </ToolScope>
      );
    }
    await act(() => root.render(<App />));
    assertConsoleErrorDev([
      'react-webmcp: This build of react-dom does not include WebMCP ' +
        '(ReactDOM.unstable_useWebMCPTool is undefined), so the tools ' +
        'declared through react-webmcp will not be registered with the ' +
        'browser. WebMCP ships in the experimental channel of react-dom.' +
        '\n    in App (at **)',
    ]);
    expect(container.textContent).toBe('hook');
    expect(result).toEqual({
      supported: false,
      registered: false,
      error: null,
      qualifiedName: 'add_todo',
      available: false,
    });
    expect(modelContext.names()).toEqual([]);
    expect(unstable_getRegisteredTools()).toEqual([]);
    const unsubscribe = unstable_subscribeToRegisteredTools(() => {});
    expect(typeof unsubscribe).toBe('function');
    unsubscribe();
    // More components do not warn again.
    await act(() =>
      root.render(
        <>
          <App />
          <App />
        </>,
      ),
    );
    expect(modelContext.names()).toEqual([]);
  });

  // @gate enableWebMCP
  it('registers a tool whose definition changed after the browser refused it', async () => {
    modelContext = createFakeModelContext({
      failOnceFor: 'refused',
      rejectOnceFor: 'rejected',
    });
    document.modelContext = modelContext;
    function App({description, showOther}) {
      return (
        <ToolTree>
          <Tool
            name="refused"
            description={description}
            safety="read"
            execute={() => 1}
          />
          <Tool
            name="rejected"
            description={description}
            safety="read"
            execute={() => 1}
          />
          {showOther ? (
            <Tool
              name="other"
              description="Other."
              safety="read"
              execute={() => 1}
            />
          ) : null}
        </ToolTree>
      );
    }
    await act(() => root.render(<App description="One." showOther={false} />));
    await act(async () => {
      await Promise.resolve();
    });
    expect(statuses()).toEqual([
      ['refused', 'error'],
      ['rejected', 'error'],
    ]);
    expect(modelContext.names()).toEqual([]);

    // Another commit that walks the tree does not retry the same definition.
    await act(() => root.render(<App description="One." showOther={true} />));
    expect(modelContext.names()).toEqual(['other']);
    expect(modelContext.attempts('refused')).toBe(1);
    expect(modelContext.attempts('rejected')).toBe(1);

    await act(() => root.render(<App description="Two." showOther={true} />));
    expect(modelContext.attempts('refused')).toBe(2);
    expect(modelContext.attempts('rejected')).toBe(2);
    expect(modelContext.names()).toEqual(['other', 'refused', 'rejected']);
    expect(statuses()).toEqual([
      ['refused', 'registered'],
      ['rejected', 'registered'],
      ['other', 'registered'],
    ]);
    expect(modelContext.tools.get('refused').description).toBe('Two.');
  });

  // @gate enableWebMCP
  it('turns asynchronous failures in execute and formatOutput into isError results', async () => {
    const errors = [];
    function App() {
      return (
        <ToolTree>
          <Tool
            name="rejects"
            description="Rejects."
            safety="read"
            onError={error => errors.push('rejects:' + error.message)}
            execute={() => Promise.reject(new Error('network down'))}
          />
          <Tool
            name="format_returns_error"
            description="Format returns an Error."
            safety="read"
            onError={error =>
              errors.push('format_returns_error:' + error.message)
            }
            formatOutput={() => new Error('nothing to show')}
            execute={() => 'raw'}
          />
          <Tool
            name="format_throws"
            description="Format throws."
            safety="read"
            onError={error => errors.push('format_throws:' + error.message)}
            formatOutput={() => {
              throw new Error('cannot format');
            }}
            execute={async () => 'raw'}
          />
          <Tool
            name="handler_throws"
            description="The error handler itself throws."
            safety="read"
            onError={() => {
              throw new Error('handler bug');
            }}
            execute={() => {
              throw new Error('original failure');
            }}
          />
        </ToolTree>
      );
    }
    await act(() => root.render(<App />));
    expect(await modelContext.executeTool('rejects', {})).toEqual({
      content: [{type: 'text', text: 'network down'}],
      isError: true,
    });
    expect(await modelContext.executeTool('format_returns_error', {})).toEqual({
      content: [{type: 'text', text: 'nothing to show'}],
      isError: true,
    });
    expect(await modelContext.executeTool('format_throws', {})).toEqual({
      content: [{type: 'text', text: 'cannot format'}],
      isError: true,
    });
    expect(await modelContext.executeTool('handler_throws', {})).toEqual({
      content: [{type: 'text', text: 'original failure'}],
      isError: true,
    });
    expect(errors).toEqual([
      'rejects:network down',
      'format_returns_error:nothing to show',
      'format_throws:cannot format',
    ]);
  });

  // @gate enableWebMCP
  it('re-registers the tools inside a Scope under its new name', async () => {
    function App({scope}) {
      return (
        <ToolTree>
          <Scope name={scope}>
            <Tool
              name="add_item"
              description="Add an item."
              safety="mutate"
              execute={() => 'ok'}
            />
          </Scope>
        </ToolTree>
      );
    }
    await act(() => root.render(<App scope="cart" />));
    await act(() => root.render(<App scope="basket" />));
    expect(modelContext.log).toEqual([
      ['register', 'cart_add_item'],
      ['abort', 'cart_add_item'],
      ['register', 'basket_add_item'],
    ]);
    expect(statuses()).toEqual([['basket_add_item', 'registered']]);
    expect(ReactDOM.unstable_getWebMCPTools()[0].scopePath).toEqual(['basket']);

    // A Scope without a name adds nothing to the path.
    await act(() => root.render(<App scope={undefined} />));
    expect(modelContext.names()).toEqual(['add_item']);
    expect(ReactDOM.unstable_getWebMCPTools()[0].scopePath).toEqual([]);
  });

  // @gate enableWebMCP
  it('reorders siblings without re-registering and re-registers a tool that moves to another scope', async () => {
    function App({order, inCart}) {
      const tools = {
        x: (
          <Tool
            key="x"
            name="x"
            description="X."
            safety="read"
            execute={() => 'x'}
          />
        ),
        y: (
          <Tool
            key="y"
            name="y"
            description="Y."
            safety="read"
            execute={() => 'y'}
          />
        ),
      };
      const moved = (
        <Tool
          key="moved"
          name="moved"
          description="Moved."
          safety="read"
          execute={() => 'moved'}
        />
      );
      return (
        <ToolTree>
          {order.map(name => tools[name])}
          <Scope name="cart">{inCart ? moved : null}</Scope>
          <Scope name="saved">{inCart ? null : moved}</Scope>
        </ToolTree>
      );
    }
    await act(() => root.render(<App order={['x', 'y']} inCart={true} />));
    const initialLog = [
      ['register', 'x'],
      ['register', 'y'],
      ['register', 'cart_moved'],
    ];
    expect(modelContext.log).toEqual(initialLog);

    // Order among siblings is not part of what the agent sees.
    await act(() => root.render(<App order={['y', 'x']} inCart={true} />));
    expect(modelContext.log).toEqual(initialLog);
    expect(statuses()).toEqual([
      ['x', 'registered'],
      ['y', 'registered'],
      ['cart_moved', 'registered'],
    ]);

    // A different parent is a new host instance: the old registration is
    // aborted before the new one is made, and the old record leaves.
    await act(() => root.render(<App order={['y', 'x']} inCart={false} />));
    expect(modelContext.log).toEqual([
      ...initialLog,
      ['abort', 'cart_moved'],
      ['register', 'saved_moved'],
    ]);
    expect(statuses()).toEqual([
      ['x', 'registered'],
      ['y', 'registered'],
      ['saved_moved', 'registered'],
    ]);
  });

  // @gate enableWebMCP
  it('rejects a Tool with children', async () => {
    function App() {
      return (
        <ToolTree>
          <Tool
            name="parent"
            description="Parent."
            safety="read"
            execute={() => 1}>
            <Scope name="inner" />
          </Tool>
        </ToolTree>
      );
    }
    await expect(act(() => root.render(<App />))).rejects.toThrow(
      'react-webmcp: A <Tool> cannot have children. Nest tools inside a ' +
        '<Scope> instead.',
    );
  });

  // @gate enableWebMCP
  it('rejects elements other than Tool and Scope', async () => {
    function App() {
      return (
        <ToolTree>
          <div />
        </ToolTree>
      );
    }
    await expect(act(() => root.render(<App />))).rejects.toThrow(
      'react-webmcp does not support the element type "div". A <ToolTree> ' +
        'can only contain <Tool> and <Scope> elements.',
    );
  });

  // @gate enableWebMCP
  it('reads target once, when the tool root is created', async () => {
    const first = createFakeModelContext();
    const second = createFakeModelContext();
    function App({target, description}) {
      return (
        <ToolTree target={target}>
          <Tool
            name="read"
            description={description}
            safety="read"
            execute={() => 1}
          />
        </ToolTree>
      );
    }
    await act(() => root.render(<App target={() => first} description="A." />));
    expect(first.names()).toEqual(['read']);
    // A new target function with a change that re-registers still goes to
    // the target the root was created with.
    await act(() =>
      root.render(<App target={() => second} description="B." />),
    );
    expect(first.registrations()).toEqual(['read', 'read']);
    expect(first.tools.get('read').description).toBe('B.');
    expect(second.registrations()).toEqual([]);
    expect(modelContext.registrations()).toEqual([]);
  });
});
