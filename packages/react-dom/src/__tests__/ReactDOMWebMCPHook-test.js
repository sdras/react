/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails react-core
 * @jest-environment jsdom
 */

'use strict';

let React;
let ReactDOM;
let ReactDOMClient;
let ReactDOMServer;
let act;
let assertConsoleErrorDev;
let createFakeModelContext;
let Registry;
let Validation;
let ModelContextStore;
let useWebMCPTool;
let WebMCPScope;

let container;
let root;
let modelContext;

function statuses() {
  return Registry.getRegisteredTools().map(tool => [
    tool.qualifiedName,
    tool.status,
    tool.source,
  ]);
}

describe('ReactDOM.unstable_useWebMCPTool', () => {
  beforeEach(() => {
    jest.resetModules();
    delete globalThis.__REACT_WEBMCP__;
    React = require('react');
    ReactDOM = require('react-dom');
    ReactDOMClient = require('react-dom/client');
    ReactDOMServer = require('react-dom/server');
    ({act, assertConsoleErrorDev} = require('internal-test-utils'));
    ({
      createFakeModelContext,
    } = require('internal-test-utils/createFakeModelContext'));
    Registry = require('react-dom/src/shared/webmcp/ReactDOMWebMCPRegistry');
    Validation = require('react-dom/src/shared/webmcp/ReactDOMWebMCPValidation');
    ModelContextStore = require('react-dom/src/shared/webmcp/ReactDOMWebMCPModelContextStore');
    useWebMCPTool = ReactDOM.unstable_useWebMCPTool;
    WebMCPScope = ReactDOM.unstable_WebMCPScope;

    Registry.resetRegistryForTesting();
    Validation.resetReportedIssuesForTesting();
    ModelContextStore.resetModelContextStoreForTesting();
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

  it('is exported only when the flag is on', () => {
    if (gate(flags => flags.enableWebMCP)) {
      expect(typeof ReactDOM.unstable_useWebMCPTool).toBe('function');
      expect(typeof ReactDOM.unstable_WebMCPScope).toBe('function');
      expect(typeof ReactDOM.unstable_getWebMCPTools).toBe('function');
      expect(typeof ReactDOM.unstable_subscribeToWebMCPTools).toBe('function');
    } else {
      expect(ReactDOM.unstable_useWebMCPTool).toBe(undefined);
      expect(ReactDOM.unstable_WebMCPScope).toBe(undefined);
      expect(ReactDOM.unstable_getWebMCPTools).toBe(undefined);
      expect(ReactDOM.unstable_subscribeToWebMCPTools).toBe(undefined);
    }
  });

  // @gate enableWebMCP
  it('registers on mount and unregisters on unmount', async () => {
    function App() {
      useWebMCPTool({
        name: 'add_todo',
        description: 'Add a todo item.',
        safety: 'mutate',
        execute: () => 'ok',
      });
      return null;
    }
    await act(() => root.render(<App />));
    expect(modelContext.names()).toEqual(['add_todo']);
    expect(statuses()).toEqual([['add_todo', 'registered', 'hook']]);

    await act(() => root.render(null));
    expect(modelContext.names()).toEqual([]);
    expect(statuses()).toEqual([]);
  });

  // @gate enableWebMCP
  it('prefixes the name with enclosing scope names', async () => {
    function App() {
      const result = useWebMCPTool({
        name: 'add_todo',
        description: 'Add a todo item.',
        safety: 'mutate',
        execute: () => 'ok',
      });
      return result.qualifiedName;
    }
    await act(() =>
      root.render(
        <WebMCPScope name="app">
          <WebMCPScope>
            <WebMCPScope name="todos">
              <App />
            </WebMCPScope>
          </WebMCPScope>
        </WebMCPScope>,
      ),
    );
    expect(modelContext.names()).toEqual(['app_todos_add_todo']);
    expect(container.textContent).toBe('app_todos_add_todo');
    expect(Registry.getRegisteredTools()[0].scopePath).toEqual([
      'app',
      'todos',
    ]);
  });

  // @gate enableWebMCP
  it('derives annotations from safety and lets explicit hints win', async () => {
    function App() {
      useWebMCPTool({
        name: 'list_todos',
        description: 'List todos.',
        safety: 'read',
        execute: () => 'ok',
      });
      useWebMCPTool({
        name: 'clear_todos',
        description: 'Delete every todo.',
        safety: 'irreversible',
        annotations: {untrustedContentHint: true},
        execute: () => 'ok',
      });
      return null;
    }
    await act(() => root.render(<App />));
    expect(modelContext.tools.get('list_todos').annotations).toEqual({
      readOnlyHint: true,
    });
    expect(modelContext.tools.get('clear_todos').annotations).toEqual({
      consequentialHint: true,
      untrustedContentHint: true,
    });
  });

  // @gate enableWebMCP
  it('does not register while disabled or while the scope is unavailable', async () => {
    function App({enabled}) {
      useWebMCPTool({
        name: 'search',
        description: 'Search.',
        safety: 'read',
        enabled,
        execute: () => 'ok',
      });
      return null;
    }
    function Wrapper({enabled, available}) {
      return (
        <WebMCPScope name="shop" available={available}>
          <App enabled={enabled} />
        </WebMCPScope>
      );
    }
    await act(() => root.render(<Wrapper enabled={false} available={true} />));
    expect(modelContext.names()).toEqual([]);
    expect(statuses()).toEqual([['shop_search', 'disabled', 'hook']]);

    await act(() => root.render(<Wrapper enabled={true} available={false} />));
    expect(modelContext.names()).toEqual([]);
    expect(statuses()).toEqual([['shop_search', 'unavailable', 'hook']]);

    await act(() => root.render(<Wrapper enabled={true} available={true} />));
    expect(modelContext.names()).toEqual(['shop_search']);
    expect(statuses()).toEqual([['shop_search', 'registered', 'hook']]);
  });

  // @gate enableWebMCP
  it('reads the latest state without re-registering', async () => {
    let setCount;
    function App() {
      const [count, _setCount] = React.useState(0);
      setCount = _setCount;
      useWebMCPTool({
        name: 'read_count',
        description: 'Read the counter.',
        safety: 'read',
        execute: () => 'count:' + count,
      });
      return count;
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
  it('re-registers exactly once when the description changes', async () => {
    function App({description}) {
      useWebMCPTool({
        name: 'read_count',
        description,
        safety: 'read',
        execute: () => 'ok',
      });
      return null;
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
  it('passes an AbortSignal to execute that fires on unmount', async () => {
    let seenSignal = null;
    function App() {
      useWebMCPTool({
        name: 'slow',
        description: 'Slow.',
        safety: 'read',
        execute: (input, {signal}) => {
          seenSignal = signal;
          return 'started';
        },
      });
      return null;
    }
    await act(() => root.render(<App />));
    await modelContext.executeTool('slow', {});
    expect(seenSignal).not.toBe(null);
    expect(seenSignal.aborted).toBe(false);
    await act(() => root.render(null));
    expect(seenSignal.aborted).toBe(true);
  });

  // @gate enableWebMCP
  it("prefers the browser's signal when the agent provides one", async () => {
    let seenSignal = null;
    function App() {
      useWebMCPTool({
        name: 'slow',
        description: 'Slow.',
        safety: 'read',
        execute: (input, {signal}) => {
          seenSignal = signal;
          return 'started';
        },
      });
      return null;
    }
    await act(() => root.render(<App />));
    const browserController = new AbortController();
    await modelContext.executeTool(
      'slow',
      {},
      {signal: browserController.signal},
    );
    expect(seenSignal).toBe(browserController.signal);
  });

  // @gate enableWebMCP
  it('reports errors from execute as isError results and formats output', async () => {
    const errors = [];
    function App() {
      useWebMCPTool({
        name: 'fails',
        description: 'Fails.',
        safety: 'read',
        onError: error => errors.push(error.message),
        execute: () => {
          throw new Error('not signed in');
        },
      });
      useWebMCPTool({
        name: 'formats',
        description: 'Formats.',
        safety: 'read',
        formatOutput: (result, input) => `${input.who}: ${result}`,
        execute: () => Promise.resolve('hello'),
      });
      return null;
    }
    await act(() => root.render(<App />));
    expect(await modelContext.executeTool('fails', {})).toEqual({
      content: [{type: 'text', text: 'not signed in'}],
      isError: true,
    });
    expect(errors).toEqual(['not signed in']);
    expect(await modelContext.executeTool('formats', {who: 'agent'})).toEqual({
      content: [{type: 'text', text: 'agent: hello'}],
    });
  });

  // Registration lives in a layout effect, which React disconnects while a
  // Suspense boundary shows its fallback and reconnects on reveal. The record
  // survives the hide so developer tooling can show the tool as hidden.
  // @gate enableWebMCP
  it('unregisters while a Suspense boundary hides its component and re-registers on reveal', async () => {
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
    function Tools() {
      useWebMCPTool({
        name: 'add_item',
        description: 'Add an item.',
        safety: 'mutate',
        execute: () => 'ok',
      });
      return 'tools';
    }
    function App({suspend}) {
      return (
        <React.Suspense fallback="loading">
          <Tools />
          <Suspender suspend={suspend} />
        </React.Suspense>
      );
    }
    await act(() => root.render(<App suspend={false} />));
    expect(modelContext.names()).toEqual(['add_item']);

    await act(() => root.render(<App suspend={true} />));
    expect(container.textContent).toBe('loading');
    expect(modelContext.names()).toEqual([]);
    expect(statuses()).toEqual([['add_item', 'unavailable', 'hook']]);
    expect(Registry.getRegisteredTools()[0].availability.hidden).toBe(true);

    await act(async () => {
      resolved = true;
      resolvePromise();
      await promise;
    });
    expect(container.textContent).toBe('tools');
    expect(modelContext.names()).toEqual(['add_item']);
    expect(modelContext.registrations()).toEqual(['add_item', 'add_item']);
    expect(statuses()).toEqual([['add_item', 'registered', 'hook']]);
    expect(Registry.getRegisteredTools()[0].availability.hidden).toBe(false);
  });

  // @gate enableWebMCP
  it('ends with a single registration under StrictMode', async () => {
    function App() {
      useWebMCPTool({
        name: 'strict',
        description: 'Strict.',
        safety: 'read',
        execute: () => 'ok',
      });
      return null;
    }
    await act(() =>
      root.render(
        <React.StrictMode>
          <App />
        </React.StrictMode>,
      ),
    );
    expect(modelContext.names()).toEqual(['strict']);
    // DEV double-invokes layout effects once on mount.
    expect(modelContext.registrations()).toHaveLength(__DEV__ ? 2 : 1);
    expect(statuses()).toEqual([['strict', 'registered', 'hook']]);
  });

  // @gate enableWebMCP
  it('reports unsupported when document.modelContext is missing', async () => {
    delete document.modelContext;
    let result;
    function App() {
      result = useWebMCPTool({
        name: 'add_item',
        description: 'Add an item.',
        safety: 'mutate',
        execute: () => 'ok',
      });
      return null;
    }
    await act(() => root.render(<App />));
    expect(result.supported).toBe(false);
    expect(result.registered).toBe(false);
    expect(statuses()).toEqual([['add_item', 'unsupported', 'hook']]);
  });

  // @gate enableWebMCP
  it('registers once document.modelContext appears later', async () => {
    delete document.modelContext;
    let result;
    function App() {
      result = useWebMCPTool({
        name: 'late',
        description: 'Late.',
        safety: 'read',
        execute: () => 'ok',
      });
      return null;
    }
    await act(() => root.render(<App />));
    expect(result.supported).toBe(false);
    expect(statuses()).toEqual([['late', 'unsupported', 'hook']]);

    document.modelContext = modelContext;
    await act(() => {
      jest.advanceTimersByTime(500);
    });
    expect(result.supported).toBe(true);
    expect(modelContext.names()).toEqual(['late']);
    expect(statuses()).toEqual([['late', 'registered', 'hook']]);
  });

  // @gate enableWebMCP
  it('reports a refused registration as an error without retrying it', async () => {
    document.modelContext = modelContext = createFakeModelContext({
      failFor: 'refused',
      rejectFor: 'rejected',
    });
    let refused;
    let rejected;
    function App({description}) {
      refused = useWebMCPTool({
        name: 'refused',
        description,
        safety: 'read',
        execute: () => 'ok',
      });
      rejected = useWebMCPTool({
        name: 'rejected',
        description,
        safety: 'read',
        execute: () => 'ok',
      });
      return null;
    }
    await act(() => root.render(<App description="One." />));
    expect(refused.registered).toBe(false);
    expect(refused.error.message).toBe('Registration refused for refused');
    expect(rejected.registered).toBe(false);
    expect(rejected.error.message).toBe(
      'Async registration refused for rejected',
    );
    expect(statuses()).toEqual([
      ['refused', 'error', 'hook'],
      ['rejected', 'error', 'hook'],
    ]);
    expect(modelContext.names()).toEqual([]);

    // The same definition is not retried on re-render; a new one is.
    await act(() => root.render(<App description="One." />));
    expect(modelContext.log).toEqual([]);
    await act(() => root.render(<App description="Two." />));
    expect(refused.error.message).toBe('Registration refused for refused');
  });

  // @gate enableWebMCP
  it('warns when execute is not a function', async () => {
    function App() {
      useWebMCPTool({
        name: 'broken',
        description: 'Broken.',
        safety: 'read',
        execute: undefined,
      });
      return null;
    }
    await act(() => root.render(<App />));
    assertConsoleErrorDev([
      'WebMCP: The tool "broken" has no `execute` function. It will not be registered.' +
        '\n    in App (at **)',
    ]);
    expect(statuses()).toEqual([['broken', 'error', 'hook']]);
  });

  // @gate enableWebMCP
  it('warns when two components register the same agent-facing name', async () => {
    function Tool({keyName}) {
      useWebMCPTool({
        key: keyName,
        name: 'add_item',
        description: 'Add an item.',
        safety: 'mutate',
        execute: () => 'ok',
      });
      return null;
    }
    await act(() =>
      root.render(
        <>
          <Tool keyName="first" />
          <Tool keyName="second" />
        </>,
      ),
    );
    assertConsoleErrorDev([
      'WebMCP: Two tools are registered with the name "add_item". ' +
        'Agents cannot tell them apart. Give each one a unique `key` and a ' +
        'distinct name, or wrap them in a <ToolScope name> to prefix it.' +
        '\n    in Tool (at **)',
    ]);
  });

  // @gate enableWebMCP
  it('exposes the registry through the public readers', async () => {
    const seen = [];
    const unsubscribe = ReactDOM.unstable_subscribeToWebMCPTools(() => {
      seen.push(ReactDOM.unstable_getWebMCPTools().map(t => t.qualifiedName));
    });
    function App() {
      useWebMCPTool({
        name: 'public',
        description: 'Public.',
        safety: 'read',
        execute: () => 'ok',
      });
      return null;
    }
    await act(() => root.render(<App />));
    expect(seen[seen.length - 1]).toEqual(['public']);
    expect('ownerToken' in ReactDOM.unstable_getWebMCPTools()[0]).toBe(false);
    unsubscribe();
  });

  // @gate enableWebMCP
  it('is inert during server rendering', () => {
    let result;
    function App() {
      result = useWebMCPTool({
        name: 'server',
        description: 'Server.',
        safety: 'read',
        execute: () => 'ok',
      });
      return result.supported ? 'supported' : 'unsupported';
    }
    const html = ReactDOMServer.renderToString(<App />);
    expect(html).toBe('unsupported');
    expect(result.registered).toBe(false);
    expect(modelContext.names()).toEqual([]);
  });
});
