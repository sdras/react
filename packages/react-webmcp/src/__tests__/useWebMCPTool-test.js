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

const {useWebMCPTool, ToolScope} = ReactWebMCP;

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

describe('useWebMCPTool', () => {
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

  it('prefixes the name with enclosing ToolScope names', async () => {
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
        <ToolScope name="app">
          <ToolScope>
            <ToolScope name="todos">
              <App />
            </ToolScope>
          </ToolScope>
        </ToolScope>,
      ),
    );
    expect(modelContext.names()).toEqual(['app_todos_add_todo']);
    expect(container.textContent).toBe('app_todos_add_todo');
    expect(Registry.getRegisteredTools()[0].scopePath).toEqual([
      'app',
      'todos',
    ]);
  });

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

  it('does not register while disabled or while the scope is unavailable', async () => {
    function App({enabled, available}) {
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
        <ToolScope name="shop" available={available}>
          <App enabled={enabled} />
        </ToolScope>
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

  it('reports errors from execute as isError results', async () => {
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
      return null;
    }
    await act(() => root.render(<App />));
    expect(await modelContext.executeTool('fails', {})).toEqual({
      content: [{type: 'text', text: 'not signed in'}],
      isError: true,
    });
    expect(errors).toEqual(['not signed in']);
  });

  // React keeps a Suspense-hidden tree mounted without running its effects,
  // so the hook path cannot pause its registration. This documents that
  // limitation; <ToolTree> is the path that tracks Suspense automatically.
  it('keeps a tool registered while a Suspense boundary hides its component', async () => {
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
    expect(modelContext.names()).toEqual(['add_item']);

    await act(async () => {
      resolved = true;
      resolvePromise();
      await promise;
    });
    expect(container.textContent).toBe('tools');
    expect(modelContext.registrations()).toEqual(['add_item']);
  });

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
      'react-webmcp: The tool "broken" has no `execute` function. It will not be registered.' +
        '\n    in App (at **)',
    ]);
    expect(statuses()).toEqual([['broken', 'error', 'hook']]);
  });

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
      'react-webmcp: Two tools are registered with the name "add_item". ' +
        'Agents cannot tell them apart. Give each one a unique `key` and a ' +
        'distinct name, or wrap them in a <ToolScope name> to prefix it.' +
        '\n    in Tool (at **)',
    ]);
  });
});
