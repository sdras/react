/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails react-core
 */

'use strict';

let React;
let ReactDOM;
let ReactDOMClient;
let ReactDOMServer;
let Scheduler;
let act;
let waitFor;
let assertLog;
let assertConsoleErrorDev;
let assertConsoleWarnDev;
let createFakeModelContext;
let useWebMCPTool;
let WebMCPScope;

let container;
let root;
let modelContext;

// The registry as the public readers expose it, which is all the built
// bundles offer; the test must not reach into react-dom's source.
function tools() {
  return ReactDOM.unstable_getWebMCPTools();
}

function statuses() {
  return tools().map(tool => [tool.qualifiedName, tool.status, tool.source]);
}

describe('ReactDOM.unstable_useWebMCPTool', () => {
  beforeEach(() => {
    // A fresh react-dom per test also means a fresh, empty registry.
    jest.resetModules();
    delete globalThis.__REACT_WEBMCP__;
    React = require('react');
    ReactDOM = require('react-dom');
    ReactDOMClient = require('react-dom/client');
    ReactDOMServer = require('react-dom/server');
    Scheduler = require('scheduler');
    ({
      act,
      waitFor,
      assertLog,
      assertConsoleErrorDev,
      assertConsoleWarnDev,
    } = require('internal-test-utils'));
    ({
      createFakeModelContext,
    } = require('internal-test-utils/createFakeModelContext'));
    useWebMCPTool = ReactDOM.unstable_useWebMCPTool;
    WebMCPScope = ReactDOM.unstable_WebMCPScope;

    modelContext = createFakeModelContext();
    document.modelContext = modelContext;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOMClient.createRoot(container);
  });

  afterEach(async () => {
    // A test that fails mid-way (a gated one with the flag off, for instance)
    // must not leak its yields into the next test's log.
    Scheduler.unstable_clearLog();
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
    expect(tools()[0].scopePath).toEqual(['app', 'todos']);
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
      useWebMCPTool({
        name: 'add_todo',
        description: 'Add a todo.',
        safety: 'mutate',
        execute: () => 'ok',
      });
      useWebMCPTool({
        name: 'peek_todos',
        description: 'Peek at todos.',
        safety: 'read',
        annotations: {readOnlyHint: false},
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
    // Mutation is what agents assume, so it adds no hint.
    expect(modelContext.tools.get('add_todo').annotations).toEqual({});
    expect(modelContext.tools.get('peek_todos').annotations).toEqual({
      readOnlyHint: false,
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
  it('replaces its record when a component renames its tool', async () => {
    function App({name}) {
      useWebMCPTool({
        name,
        description: 'Tool.',
        safety: 'read',
        execute: () => 'ok',
      });
      return null;
    }
    await act(() => root.render(<App name="before" />));
    await act(() => root.render(<App name="after" />));
    expect(modelContext.names()).toEqual(['after']);
    // One record per component: the old name left with the old record.
    expect(statuses()).toEqual([['after', 'registered', 'hook']]);
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

  // The signal execute receives combines the browser's with the tool's own
  // lifetime: whichever aborts first aborts it, with that side's reason, and
  // neither side is dropped because the other exists.
  async function expectExecuteSignalToCombineBothSides() {
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
    expect(seenSignal.aborted).toBe(false);
    const reason = new Error('user cancelled');
    browserController.abort(reason);
    expect(seenSignal.aborted).toBe(true);
    expect(seenSignal.reason).toBe(reason);

    // The tool's own lifetime is never dropped because the browser supplied
    // a signal: a call in flight stops when its UI goes away.
    const laterController = new AbortController();
    await modelContext.executeTool(
      'slow',
      {},
      {signal: laterController.signal},
    );
    expect(seenSignal.aborted).toBe(false);
    await act(() => root.render(null));
    expect(seenSignal.aborted).toBe(true);
    expect(laterController.signal.aborted).toBe(false);
  }

  // @gate enableWebMCP
  it("aborts execute's signal when the browser cancels the call or the tool goes away", async () => {
    expect(typeof AbortSignal.any).toBe('function');
    await expectExecuteSignalToCombineBothSides();
  });

  // A browser without AbortSignal.any gets the two signals combined by hand.
  // Both paths must behave the same.
  // @gate enableWebMCP
  it("aborts execute's signal the same way in a browser without AbortSignal.any", async () => {
    const original = AbortSignal.any;
    AbortSignal.any = undefined;
    try {
      await expectExecuteSignalToCombineBothSides();
    } finally {
      AbortSignal.any = original;
    }
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

  // What execute returns becomes an MCP result the same way for every tool:
  // text is wrapped, nothing is an empty success, a result already in MCP
  // shape passes through as it is, and anything else is JSON.
  // @gate enableWebMCP
  it('normalizes what execute returns into an MCP result', async () => {
    const shaped = {content: [{type: 'text', text: 'shaped'}], isError: false};
    const circular = {};
    circular.self = circular;
    function App() {
      useWebMCPTool({
        name: 'text',
        description: 'Text.',
        safety: 'read',
        execute: () => 'done',
      });
      useWebMCPTool({
        name: 'nothing',
        description: 'Nothing.',
        safety: 'read',
        execute: () => undefined,
      });
      useWebMCPTool({
        name: 'null_result',
        description: 'Null.',
        safety: 'read',
        execute: () => null,
      });
      useWebMCPTool({
        name: 'shaped',
        description: 'Shaped.',
        safety: 'read',
        execute: () => shaped,
      });
      useWebMCPTool({
        name: 'object',
        description: 'Object.',
        safety: 'read',
        execute: () => ({items: [1, 2]}),
      });
      useWebMCPTool({
        name: 'number',
        description: 'Number.',
        safety: 'read',
        execute: () => 42,
      });
      useWebMCPTool({
        name: 'circular',
        description: 'Circular.',
        safety: 'read',
        execute: () => circular,
      });
      return null;
    }
    await act(() => root.render(<App />));
    expect(await modelContext.executeTool('text', {})).toEqual({
      content: [{type: 'text', text: 'done'}],
    });
    expect(await modelContext.executeTool('nothing', {})).toEqual({
      content: [],
    });
    expect(await modelContext.executeTool('null_result', {})).toEqual({
      content: [],
    });
    expect(await modelContext.executeTool('shaped', {})).toBe(shaped);
    expect(await modelContext.executeTool('object', {})).toEqual({
      content: [{type: 'text', text: '{"items":[1,2]}'}],
    });
    expect(await modelContext.executeTool('number', {})).toEqual({
      content: [{type: 'text', text: '42'}],
    });
    // A value JSON cannot serialize still produces a result.
    expect(await modelContext.executeTool('circular', {})).toEqual({
      content: [{type: 'text', text: '[object Object]'}],
    });
  });

  // A thrown value that is not an Error must still read as a failure to the
  // agent, never as a successful result.
  // @gate enableWebMCP
  it('turns a thrown string or object into an isError result', async () => {
    const errors = [];
    function App() {
      useWebMCPTool({
        name: 'throws_string',
        description: 'Throws a string.',
        safety: 'read',
        onError: error => errors.push(error),
        execute: () => {
          // eslint-disable-next-line no-throw-literal
          throw 'not signed in';
        },
      });
      useWebMCPTool({
        name: 'throws_object',
        description: 'Throws an object.',
        safety: 'read',
        onError: error => errors.push(error),
        execute: () => {
          // eslint-disable-next-line no-throw-literal
          throw {code: 403};
        },
      });
      return null;
    }
    await act(() => root.render(<App />));
    expect(await modelContext.executeTool('throws_string', {})).toEqual({
      content: [{type: 'text', text: 'not signed in'}],
      isError: true,
    });
    expect(await modelContext.executeTool('throws_object', {})).toEqual({
      content: [{type: 'text', text: '{"code":403}'}],
      isError: true,
    });
    // onError receives what was thrown, as it was thrown.
    expect(errors).toEqual(['not signed in', {code: 403}]);
  });

  // Registration lives in a layout effect, which React disconnects while a
  // Suspense boundary shows its fallback and reconnects on reveal. The record
  // survives this hide, because React keeps passive effects connected under a
  // fallback, so developer tooling can show the tool as hidden.
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
    expect(tools()[0].availability.hidden).toBe(true);

    await act(async () => {
      resolved = true;
      resolvePromise();
      await promise;
    });
    expect(container.textContent).toBe('tools');
    expect(modelContext.names()).toEqual(['add_item']);
    expect(modelContext.registrations()).toEqual(['add_item', 'add_item']);
    expect(statuses()).toEqual([['add_item', 'registered', 'hook']]);
    expect(tools()[0].availability.hidden).toBe(false);
  });

  // A hidden Activity boundary disconnects the passive effects too (the
  // reconciler keeps them connected under a Suspense fallback only, for
  // backwards compatibility), so the record leaves the registry together with
  // the registration instead of staying listed as hidden. Both come back on
  // reveal.
  // @gate enableWebMCP
  it('unregisters and drops the record while an Activity boundary hides its component, and restores both on reveal', async () => {
    function Tools() {
      useWebMCPTool({
        name: 'add_item',
        description: 'Add an item.',
        safety: 'mutate',
        execute: () => 'ok',
      });
      return 'tools';
    }
    function App({mode}) {
      return (
        <React.Activity mode={mode}>
          <Tools />
        </React.Activity>
      );
    }
    await act(() => root.render(<App mode="visible" />));
    expect(container.textContent).toBe('tools');
    expect(modelContext.names()).toEqual(['add_item']);
    expect(statuses()).toEqual([['add_item', 'registered', 'hook']]);

    await act(() => root.render(<App mode="hidden" />));
    expect(container.textContent).toBe('');
    expect(modelContext.names()).toEqual([]);
    expect(modelContext.log).toEqual([
      ['register', 'add_item'],
      ['abort', 'add_item'],
    ]);
    expect(statuses()).toEqual([]);

    await act(() => root.render(<App mode="visible" />));
    expect(container.textContent).toBe('tools');
    expect(modelContext.names()).toEqual(['add_item']);
    expect(modelContext.registrations()).toEqual(['add_item', 'add_item']);
    expect(statuses()).toEqual([['add_item', 'registered', 'hook']]);
    expect(tools()[0].availability.hidden).toBe(false);
  });

  // The record is mirrored into a ref by a layout effect, never during
  // render. A transition that React interrupts must not leave a record under
  // a name that never committed.
  // @gate enableWebMCP
  it('does not leak a record from a render React discarded', async () => {
    const never = new Promise(() => {});
    const Tools = React.memo(function Tools({name}) {
      Scheduler.log('Tools ' + name);
      useWebMCPTool({
        name,
        description: 'Tool.',
        safety: 'read',
        execute: () => 1,
      });
      return null;
    });
    function Gate({suspend}) {
      Scheduler.log('Gate');
      if (suspend) {
        throw never;
      }
      return null;
    }
    let setName;
    let setSuspend;
    function App() {
      const [name, _setName] = React.useState('a');
      const [suspend, _setSuspend] = React.useState(false);
      setName = _setName;
      setSuspend = _setSuspend;
      return (
        <React.Suspense fallback="loading">
          <Tools name={name} />
          <Gate suspend={suspend} />
        </React.Suspense>
      );
    }
    await act(() => root.render(<App />));
    // The registering commit's layout effect records the browser's acceptance,
    // which re-renders Tools once with `registered: true`.
    assertLog(['Tools a', 'Gate', 'Tools a']);
    expect(modelContext.names()).toEqual(['a']);

    // A transition renames the tool and yields after Tools rendered with the
    // new name, before anything commits.
    React.startTransition(() => setName('b'));
    await waitFor(['Tools b']);

    // An urgent update interrupts it and hides the boundary. Tools bails out
    // (memo, same props), so only its committed record may be touched.
    ReactDOM.flushSync(() => setSuspend(true));
    assertLog(['Gate']);
    expect(container.textContent).toBe('loading');
    expect(modelContext.names()).toEqual([]);
    expect(tools().map(t => [t.key, t.status, t.availability.hidden])).toEqual([
      ['a', 'unavailable', true],
    ]);

    await act(() => root.render(null));
    expect(statuses()).toEqual([]);
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
  it('reports unsupported when document.modelContext cannot register tools', async () => {
    document.modelContext = {};
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
  it('does not poll while document.modelContext is present', async () => {
    function App() {
      useWebMCPTool({
        name: 'present',
        description: 'Present.',
        safety: 'read',
        execute: () => 'ok',
      });
      return null;
    }
    await act(() => root.render(<App />));
    expect(modelContext.names()).toEqual(['present']);
    expect(jest.getTimerCount()).toBe(0);
  });

  // A browser extension can inject document.modelContext after the page has
  // rendered, so while any tool waits for it, one shared poll looks for it.
  // @gate enableWebMCP
  it('shares one poll between waiting tools and stops it once document.modelContext appears', async () => {
    delete document.modelContext;
    function Tool({name}) {
      useWebMCPTool({
        name,
        description: 'Tool.',
        safety: 'read',
        execute: () => 'ok',
      });
      return null;
    }
    await act(() =>
      root.render(
        <>
          <Tool name="first" />
          <Tool name="second" />
        </>,
      ),
    );
    expect(jest.getTimerCount()).toBe(1);
    await act(() => {
      jest.advanceTimersByTime(500 * 3);
    });
    expect(statuses()).toEqual([
      ['first', 'unsupported', 'hook'],
      ['second', 'unsupported', 'hook'],
    ]);

    document.modelContext = modelContext;
    await act(() => {
      jest.advanceTimersByTime(500);
    });
    expect(modelContext.names()).toEqual(['first', 'second']);
    expect(jest.getTimerCount()).toBe(0);
  });

  // @gate enableWebMCP
  it('stops polling when the last waiting tool unmounts', async () => {
    delete document.modelContext;
    function Tool({name}) {
      useWebMCPTool({
        name,
        description: 'Tool.',
        safety: 'read',
        execute: () => 'ok',
      });
      return null;
    }
    function App({showSecond}) {
      return (
        <>
          <Tool name="first" />
          {showSecond ? <Tool name="second" /> : null}
        </>
      );
    }
    await act(() => root.render(<App showSecond={true} />));
    expect(jest.getTimerCount()).toBe(1);
    await act(() => root.render(<App showSecond={false} />));
    expect(jest.getTimerCount()).toBe(1);
    await act(() => root.render(null));
    expect(jest.getTimerCount()).toBe(0);
  });

  // The poll is bounded: a page whose browser never gets the API must not run
  // a timer forever. A tool that mounts later starts looking again.
  // @gate enableWebMCP
  it('gives up polling after ten seconds and starts over for a tool that mounts later', async () => {
    delete document.modelContext;
    let result;
    function App({name}) {
      result = useWebMCPTool({
        name,
        description: 'Tool.',
        safety: 'read',
        execute: () => 'ok',
      });
      return null;
    }
    await act(() => root.render(<App name="early" />));
    expect(jest.getTimerCount()).toBe(1);
    // Nothing of React's runs while the API stays missing, so the timers are
    // advanced outside act, which would otherwise fire a poll of its own.
    // Halfway through the budget the poll is still running...
    jest.advanceTimersByTime(5000);
    expect(jest.getTimerCount()).toBe(1);
    // ...and past it, it is gone.
    jest.advanceTimersByTime(5000);
    expect(jest.getTimerCount()).toBe(0);

    // An API that shows up after that is not noticed by the finished poll...
    document.modelContext = modelContext;
    jest.advanceTimersByTime(10000);
    expect(result.supported).toBe(false);
    expect(modelContext.names()).toEqual([]);
    // ...but the next render reads it.
    await act(() => root.render(<App name="early" />));
    expect(result.supported).toBe(true);
    expect(modelContext.names()).toEqual(['early']);

    // A tool that mounts while the API is missing starts a new poll.
    await act(() => root.render(null));
    delete document.modelContext;
    await act(() => root.render(<App name="late" />));
    expect(jest.getTimerCount()).toBe(1);
    document.modelContext = modelContext;
    await act(() => {
      jest.advanceTimersByTime(500);
    });
    expect(modelContext.names()).toEqual(['late']);
    expect(jest.getTimerCount()).toBe(0);
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
    // Records are listed in the order they were first written: the rejected
    // tool's registration wrote its record in the layout phase, the refused
    // one only reached the registry in the passive phase.
    expect(statuses()).toEqual([
      ['rejected', 'error', 'hook'],
      ['refused', 'error', 'hook'],
    ]);
    expect(modelContext.names()).toEqual([]);
    expect(modelContext.attempts('refused')).toBe(1);
    expect(modelContext.attempts('rejected')).toBe(1);

    // The same definition is not retried on re-render; a new one is.
    await act(() => root.render(<App description="One." />));
    expect(modelContext.log).toEqual([]);
    expect(modelContext.attempts('refused')).toBe(1);
    expect(modelContext.attempts('rejected')).toBe(1);
    await act(() => root.render(<App description="Two." />));
    expect(modelContext.attempts('refused')).toBe(2);
    expect(modelContext.attempts('rejected')).toBe(2);
    expect(refused.error.message).toBe('Registration refused for refused');
    expect(rejected.error.message).toBe(
      'Async registration refused for rejected',
    );
  });

  // @gate enableWebMCP
  it('registers a tool whose definition changed after the browser refused it', async () => {
    document.modelContext = modelContext = createFakeModelContext({
      failOnceFor: 'refused',
      rejectOnceFor: 'rejected',
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
    expect(refused.error.message).toBe('Registration refused for refused');
    expect(rejected.error.message).toBe(
      'Async registration refused for rejected',
    );
    expect(modelContext.names()).toEqual([]);

    await act(() => root.render(<App description="Two." />));
    expect(modelContext.attempts('refused')).toBe(2);
    expect(modelContext.attempts('rejected')).toBe(2);
    expect(refused.error).toBe(null);
    expect(refused.registered).toBe(true);
    expect(rejected.error).toBe(null);
    expect(rejected.registered).toBe(true);
    expect(modelContext.names()).toEqual(['refused', 'rejected']);
    expect(modelContext.tools.get('refused').description).toBe('Two.');
    expect(statuses()).toEqual([
      ['rejected', 'registered', 'hook'],
      ['refused', 'registered', 'hook'],
    ]);
  });

  // `registered` is committed truth. The render that leads to a registration
  // cannot know the browser's answer, so it reports false; the layout effect
  // that registers the tool records the acceptance and the hook re-renders
  // with it. A refused definition never reports true, and a browser that
  // answers asynchronously is not counted until it does.
  // @gate enableWebMCP
  it('reports registered only once the browser has accepted the definition', async () => {
    document.modelContext = modelContext = createFakeModelContext({
      failFor: 'refused',
      pendingFor: 'pending',
    });
    const seen = {accepted: [], refused: [], pending: []};
    function Tool({name}) {
      const result = useWebMCPTool({
        name,
        description: 'Tool.',
        safety: 'read',
        execute: () => 'ok',
      });
      seen[name].push(result.registered);
      return null;
    }
    await act(() =>
      root.render(
        <>
          <Tool name="accepted" />
          <Tool name="refused" />
          <Tool name="pending" />
        </>,
      ),
    );
    expect(seen.accepted).toEqual([false, true]);
    expect(seen.refused).toEqual([false, false]);
    expect(seen.pending).toEqual([false]);
    expect(modelContext.names()).toEqual(['accepted']);

    await act(() => modelContext.resolveRegistration('pending'));
    expect(seen.pending).toEqual([false, true]);
    expect(modelContext.names()).toEqual(['accepted', 'pending']);
  });

  // The record is rewritten in place when availability changes. Developer
  // tooling subscribed to the registry must never see a snapshot without the
  // tool, and the list must keep its order.
  // @gate enableWebMCP
  it('keeps a toggled tool in place in the registry and never drops it', async () => {
    const snapshots = [];
    const unsubscribe = ReactDOM.unstable_subscribeToWebMCPTools(() => {
      snapshots.push(
        ReactDOM.unstable_getWebMCPTools().map(t => [
          t.qualifiedName,
          t.status,
        ]),
      );
    });
    function App({enabled}) {
      useWebMCPTool({
        name: 'first',
        description: 'First.',
        safety: 'read',
        enabled,
        execute: () => 1,
      });
      useWebMCPTool({
        name: 'second',
        description: 'Second.',
        safety: 'read',
        execute: () => 2,
      });
      return null;
    }
    await act(() => root.render(<App enabled={true} />));
    expect(statuses()).toEqual([
      ['first', 'registered', 'hook'],
      ['second', 'registered', 'hook'],
    ]);
    snapshots.length = 0;

    await act(() => root.render(<App enabled={false} />));
    // One write from the layout cleanup (the registration is gone, the
    // record is hidden) and one from the passive effect with the new status.
    expect(snapshots).toEqual([
      [
        ['first', 'unavailable'],
        ['second', 'registered'],
      ],
      [
        ['first', 'disabled'],
        ['second', 'registered'],
      ],
    ]);
    expect(modelContext.names()).toEqual(['second']);
    snapshots.length = 0;

    await act(() => root.render(<App enabled={true} />));
    expect(snapshots).toEqual([
      [
        ['first', 'registered'],
        ['second', 'registered'],
      ],
    ]);
    expect(modelContext.names()).toEqual(['first', 'second']);
    // Re-registered under the same record, in the same position.
    expect(modelContext.registrations()).toEqual(['first', 'second', 'first']);
    unsubscribe();
  });

  // @gate enableWebMCP
  it('does not re-register when inline schema and annotation objects are recreated', async () => {
    function App({count}) {
      useWebMCPTool({
        name: 'read_count',
        description: 'Read the counter.',
        safety: 'read',
        inputSchema: {type: 'object', properties: {}},
        annotations: {idempotentHint: true},
        execute: () => count,
      });
      return null;
    }
    await act(() => root.render(<App count={0} />));
    await act(() => root.render(<App count={1} />));
    await act(() => root.render(<App count={2} />));
    expect(modelContext.registrations()).toEqual(['read_count']);
    expect(modelContext.tools.get('read_count').annotations).toEqual({
      readOnlyHint: true,
      idempotentHint: true,
    });
    expect(await modelContext.executeTool('read_count', {})).toEqual({
      content: [{type: 'text', text: '2'}],
    });
    // A different schema is a different tool.
    function Changed() {
      useWebMCPTool({
        name: 'read_count',
        description: 'Read the counter.',
        safety: 'read',
        inputSchema: {type: 'object', properties: {verbose: {type: 'boolean'}}},
        annotations: {idempotentHint: true},
        execute: () => 3,
      });
      return null;
    }
    await act(() => root.render(<Changed />));
    expect(modelContext.registrations()).toEqual(['read_count', 'read_count']);
  });

  // The function handed to the browser never rejects: every way a call can
  // fail becomes an isError result.
  // @gate enableWebMCP
  it('turns asynchronous failures in execute and formatOutput into isError results', async () => {
    const errors = [];
    function App() {
      useWebMCPTool({
        name: 'rejects',
        description: 'Rejects.',
        safety: 'read',
        onError: error => errors.push('rejects:' + error.message),
        execute: () => Promise.reject(new Error('network down')),
      });
      useWebMCPTool({
        name: 'format_returns_error',
        description: 'Format returns an Error.',
        safety: 'read',
        onError: error => errors.push('format_returns_error:' + error.message),
        formatOutput: () => new Error('nothing to show'),
        execute: () => 'raw',
      });
      useWebMCPTool({
        name: 'format_throws',
        description: 'Format throws.',
        safety: 'read',
        onError: error => errors.push('format_throws:' + error.message),
        formatOutput: () => {
          throw new Error('cannot format');
        },
        execute: async () => 'raw',
      });
      return null;
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
    expect(errors).toEqual([
      'rejects:network down',
      'format_returns_error:nothing to show',
      'format_throws:cannot format',
    ]);
  });

  // An onError that throws must neither mask the tool's failure nor be
  // swallowed: the agent gets the original failure, and the handler's error
  // is reported as an uncaught error, like one thrown from an event handler.
  // @gate enableWebMCP
  it('surfaces an error thrown by onError without masking the tool failure', async () => {
    const uncaught = [];
    function handleWindowError(event) {
      event.preventDefault();
      uncaught.push(event.error.message);
    }
    function App() {
      useWebMCPTool({
        name: 'handler_throws',
        description: 'The error handler itself throws.',
        safety: 'read',
        onError: () => {
          throw new Error('handler bug');
        },
        execute: () => {
          throw new Error('original failure');
        },
      });
      return null;
    }
    await act(() => root.render(<App />));
    window.addEventListener('error', handleWindowError);
    try {
      expect(await modelContext.executeTool('handler_throws', {})).toEqual({
        content: [{type: 'text', text: 'original failure'}],
        isError: true,
      });
    } finally {
      window.removeEventListener('error', handleWindowError);
    }
    expect(uncaught).toEqual(['handler bug']);
  });

  // The server snapshot says unsupported, the client snapshot says supported
  // once document.modelContext exists. useSyncExternalStore hydrates with the
  // server value and then re-renders with the client one, so there is no
  // hydration mismatch and the tool registers right after hydration.
  // @gate enableWebMCP
  it('hydrates with the server snapshot and registers after hydration', async () => {
    let result;
    function App() {
      result = useWebMCPTool({
        name: 'hydrated',
        description: 'Hydrated.',
        safety: 'read',
        execute: () => 'ok',
      });
      return result.supported ? 'supported' : 'unsupported';
    }
    const hydrationContainer = document.createElement('div');
    document.body.appendChild(hydrationContainer);
    hydrationContainer.innerHTML = ReactDOMServer.renderToString(<App />);
    expect(hydrationContainer.textContent).toBe('unsupported');
    expect(modelContext.names()).toEqual([]);

    let hydratedRoot;
    await act(() => {
      hydratedRoot = ReactDOMClient.hydrateRoot(hydrationContainer, <App />);
    });
    expect(hydrationContainer.textContent).toBe('supported');
    expect(result.supported).toBe(true);
    expect(result.registered).toBe(true);
    expect(modelContext.names()).toEqual(['hydrated']);
    expect(modelContext.registrations()).toEqual(['hydrated']);
    expect(statuses()).toEqual([['hydrated', 'registered', 'hook']]);

    await act(() => hydratedRoot.unmount());
    document.body.removeChild(hydrationContainer);
    expect(modelContext.names()).toEqual([]);
    expect(statuses()).toEqual([]);
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
      'The WebMCP tool "broken" has no `execute` function. It will not be ' +
        'registered.' +
        '\n    in App (at **)',
    ]);
    expect(statuses()).toEqual([['broken', 'error', 'hook']]);
    expect(tools()[0].error).toBe(
      'The WebMCP tool "broken" has no `execute` function.',
    );
  });

  // @gate enableWebMCP
  it('warns when two components register the same agent-facing name', async () => {
    function Tool({keyName, enabled}) {
      useWebMCPTool({
        key: keyName,
        name: 'add_item',
        description: 'Add an item.',
        safety: 'mutate',
        enabled,
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
      'Two WebMCP tools are registered with the name "add_item". Agents ' +
        'cannot tell them apart. Give them distinct names, or wrap one in ' +
        '<ReactDOM.unstable_WebMCPScope name> to prefix it.' +
        '\n    in Tool (at **)',
    ]);
    // A change to a tool's availability is not a new definition, so the same
    // problem is not reported again.
    await act(() =>
      root.render(
        <>
          <Tool keyName="first" />
          <Tool keyName="second" enabled={false} />
        </>,
      ),
    );
    expect(statuses()).toEqual([
      ['add_item', 'registered', 'hook'],
      ['add_item', 'disabled', 'hook'],
    ]);
  });

  // @gate enableWebMCP
  it('warns when two components share one name and no key, and keeps the live record', async () => {
    function Tool({id}) {
      useWebMCPTool({
        name: 'add_item',
        description: 'Add an item (' + id + ').',
        safety: 'mutate',
        execute: () => id,
      });
      return null;
    }
    function App({showFirst, showSecond}) {
      return (
        <>
          {showFirst ? <Tool id="first" /> : null}
          {showSecond ? <Tool id="second" /> : null}
        </>
      );
    }
    await act(() => root.render(<App showFirst={true} showSecond={true} />));
    assertConsoleErrorDev([
      'Two components registered a WebMCP tool named "add_item" without ' +
        'distinct keys. Agents cannot tell them apart, and developer tooling ' +
        'only keeps the most recent one. Give them distinct names, wrap one ' +
        'in <ReactDOM.unstable_WebMCPScope name> to prefix it, or pass a ' +
        'unique `key` option to each ReactDOM.unstable_useWebMCPTool call.' +
        '\n    in App (at **)',
    ]);
    // Tooling shows the most recently written of the two.
    expect(statuses()).toEqual([['add_item', 'registered', 'hook']]);
    expect(tools()[0].description).toBe('Add an item (second).');

    // The first component unmounting must not remove the second's record.
    await act(() => root.render(<App showFirst={false} showSecond={true} />));
    expect(statuses()).toEqual([['add_item', 'registered', 'hook']]);
    expect(tools()[0].description).toBe('Add an item (second).');
    expect(modelContext.names()).toEqual(['add_item']);

    await act(() => root.render(<App showFirst={false} showSecond={false} />));
    expect(statuses()).toEqual([]);
    expect(modelContext.names()).toEqual([]);
  });

  // @gate enableWebMCP
  it('reports a collision with a component a Suspense boundary is hiding, from the one that caused it', async () => {
    const never = new Promise(() => {});
    function Gate({suspend}) {
      if (suspend) {
        throw never;
      }
      return null;
    }
    function Hidden() {
      useWebMCPTool({
        name: 'add_item',
        description: 'Add an item.',
        safety: 'mutate',
        execute: () => 'hidden',
      });
      return null;
    }
    function Newcomer() {
      useWebMCPTool({
        name: 'add_item',
        description: 'Add an item.',
        safety: 'mutate',
        execute: () => 'newcomer',
      });
      return null;
    }
    // An owner of its own, so the stack tells the two components apart.
    function Late() {
      return <Newcomer />;
    }
    function App({suspend, showNewcomer}) {
      return (
        <>
          <React.Suspense fallback="loading">
            <Hidden />
            <Gate suspend={suspend} />
          </React.Suspense>
          {showNewcomer ? <Late /> : null}
        </>
      );
    }
    await act(() => root.render(<App suspend={false} showNewcomer={false} />));
    await act(() => root.render(<App suspend={true} showNewcomer={false} />));
    expect(statuses()).toEqual([['add_item', 'unavailable', 'hook']]);

    // The hidden tool still holds the key: a real collision, reported now and
    // attributed to the component that mounted into it.
    await act(() => root.render(<App suspend={true} showNewcomer={true} />));
    assertConsoleErrorDev([
      'Two components registered a WebMCP tool named "add_item" without ' +
        'distinct keys. Agents cannot tell them apart, and developer tooling ' +
        'only keeps the most recent one. Give them distinct names, wrap one ' +
        'in <ReactDOM.unstable_WebMCPScope name> to prefix it, or pass a ' +
        'unique `key` option to each ReactDOM.unstable_useWebMCPTool call.' +
        '\n    in Late (at **)' +
        '\n    in App (at **)',
    ]);
    // Tooling shows the live one.
    expect(statuses()).toEqual([['add_item', 'registered', 'hook']]);
  });

  // @gate enableWebMCP
  it('reports a second collision on the same key after the first is fixed', async () => {
    function Tool({id}) {
      useWebMCPTool({
        name: 'add_item',
        description: 'Add an item.',
        safety: 'mutate',
        execute: () => id,
      });
      return null;
    }
    const collisionMessage =
      'Two components registered a WebMCP tool named "add_item" without ' +
      'distinct keys. Agents cannot tell them apart, and developer tooling ' +
      'only keeps the most recent one. Give them distinct names, wrap one ' +
      'in <ReactDOM.unstable_WebMCPScope name> to prefix it, or pass a ' +
      'unique `key` option to each ReactDOM.unstable_useWebMCPTool call.';
    await act(() =>
      root.render(
        <>
          <Tool key="a" id="a" />
          <Tool key="b" id="b" />
        </>,
      ),
    );
    assertConsoleErrorDev([collisionMessage + '\n    in Tool (at **)']);
    // b leaves; a third component later makes the same mistake with a.
    await act(() => root.render(<Tool key="a" id="a" />));
    await act(() =>
      root.render(
        <>
          <Tool key="a" id="a" />
          <Tool key="c" id="c" />
        </>,
      ),
    );
    assertConsoleErrorDev([collisionMessage + '\n    in Tool (at **)']);
  });

  // @gate enableWebMCP
  it('does not warn when a key change replaces the component in one commit', async () => {
    function Tool({version}) {
      useWebMCPTool({
        name: 'add_item',
        description: 'Add an item.',
        safety: 'mutate',
        execute: () => version,
      });
      return null;
    }
    await act(() => root.render(<Tool key="v1" version={1} />));
    await act(() => root.render(<Tool key="v2" version={2} />));
    // The old instance's cleanup ran before the new one registered, and must
    // not remove the record the new one owns.
    expect(statuses()).toEqual([['add_item', 'registered', 'hook']]);
    expect(modelContext.names()).toEqual(['add_item']);
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
  it('reports a tool without a name', async () => {
    function App() {
      useWebMCPTool({
        name: '',
        description: 'Nameless.',
        safety: 'read',
        execute: () => 'ok',
      });
      return null;
    }
    await act(() => root.render(<App />));
    assertConsoleErrorDev([
      'Expected the `name` of a WebMCP tool to be a non-empty string.' +
        '\n    in App (at **)',
    ]);
  });

  // @gate enableWebMCP
  it('reports a tool without a description', async () => {
    function App() {
      useWebMCPTool({
        name: 'add_item',
        description: '',
        safety: 'mutate',
        execute: () => 'ok',
      });
      return null;
    }
    await act(() => root.render(<App />));
    assertConsoleErrorDev([
      'The WebMCP tool "add_item" has no description. Agents pick tools by ' +
        'their descriptions; say what the tool does and when to use it.' +
        '\n    in App (at **)',
    ]);
  });

  // The agent-facing name is checked as a whole, so a scope name outside the
  // character set is reported on the tools it prefixes.
  // @gate enableWebMCP
  it('reports a name with characters agents may reject, from the tool or from a scope', async () => {
    function Spaced() {
      useWebMCPTool({
        name: 'add item',
        description: 'Add an item.',
        safety: 'mutate',
        execute: () => 'ok',
      });
      return null;
    }
    function Scoped() {
      useWebMCPTool({
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
          <Spaced />
          <WebMCPScope name="my cart">
            <Scoped />
          </WebMCPScope>
        </>,
      ),
    );
    assertConsoleErrorDev([
      'The WebMCP tool name "add item" contains characters other than ' +
        'letters, digits, underscores and hyphens, which agents may reject. ' +
        'Use only those in tool and scope names, like "add_item".' +
        '\n    in Spaced (at **)',
      'The WebMCP tool name "my cart_add_item" contains characters other ' +
        'than letters, digits, underscores and hyphens, which agents may ' +
        'reject. Use only those in tool and scope names, like "add_item".' +
        '\n    in Scoped (at **)',
    ]);
  });

  // @gate enableWebMCP
  it('warns when a tool name is longer than agents expect', async () => {
    function App() {
      useWebMCPTool({
        name: 'a_very_long_tool_name_that_goes_past_thirty',
        description: 'Long.',
        safety: 'read',
        execute: () => 'ok',
      });
      return null;
    }
    await act(() => root.render(<App />));
    assertConsoleWarnDev([
      'The WebMCP tool name "a_very_long_tool_name_that_goes_past_thirty" is ' +
        'longer than 30 characters. Prefer short, action-oriented names like ' +
        '"add_item".' +
        '\n    in App (at **)',
    ]);
  });

  // @gate enableWebMCP
  it('warns when scope prefixes push a short name over the budget, and only about the name when that is long itself', async () => {
    function Short() {
      useWebMCPTool({
        name: 'add_item',
        description: 'Add an item.',
        safety: 'mutate',
        execute: () => 'ok',
      });
      return null;
    }
    function Long() {
      useWebMCPTool({
        name: 'a_very_long_tool_name_that_goes_past_thirty',
        description: 'Long.',
        safety: 'read',
        execute: () => 'ok',
      });
      return null;
    }
    await act(() =>
      root.render(
        <WebMCPScope name="checkout">
          <WebMCPScope name="shipping">
            <WebMCPScope name="address">
              <Short />
            </WebMCPScope>
          </WebMCPScope>
          <Long />
        </WebMCPScope>,
      ),
    );
    assertConsoleWarnDev([
      'The scoped WebMCP tool name "checkout_shipping_address_add_item" is ' +
        'longer than 30 characters. Use shorter scope names.' +
        '\n    in Short (at **)',
      'The WebMCP tool name ' +
        '"checkout_a_very_long_tool_name_that_goes_past_thirty" is longer ' +
        'than 30 characters. Prefer short, action-oriented names like ' +
        '"add_item".' +
        '\n    in Long (at **)',
    ]);
  });

  // @gate enableWebMCP
  it('warns when a description is longer than agents may keep', async () => {
    function App() {
      useWebMCPTool({
        name: 'verbose',
        description: 'x'.repeat(501),
        safety: 'read',
        execute: () => 'ok',
      });
      return null;
    }
    await act(() => root.render(<App />));
    assertConsoleWarnDev([
      'The description of the WebMCP tool "verbose" is longer than 500 ' +
        'characters. Agents may truncate it.' +
        '\n    in App (at **)',
    ]);
  });

  // @gate enableWebMCP
  it('warns when a parameter description is longer than agents may keep', async () => {
    function App() {
      useWebMCPTool({
        name: 'add_item',
        description: 'Add an item.',
        safety: 'mutate',
        inputSchema: {
          type: 'object',
          properties: {sku: {type: 'string', description: 'y'.repeat(151)}},
        },
        execute: () => 'ok',
      });
      return null;
    }
    await act(() => root.render(<App />));
    assertConsoleWarnDev([
      'The description of parameter "sku" on the WebMCP tool "add_item" is ' +
        'longer than 150 characters.' +
        '\n    in App (at **)',
    ]);
  });

  // @gate enableWebMCP
  it('reports a required property the inputSchema does not declare', async () => {
    function App() {
      useWebMCPTool({
        name: 'add_item',
        description: 'Add an item.',
        safety: 'mutate',
        inputSchema: {
          type: 'object',
          properties: {sku: {type: 'string'}},
          required: ['sku', 'quantity'],
        },
        execute: () => 'ok',
      });
      return null;
    }
    await act(() => root.render(<App />));
    assertConsoleErrorDev([
      'The inputSchema of the WebMCP tool "add_item" marks "quantity" as ' +
        'required but does not declare it in `properties`.' +
        '\n    in App (at **)',
    ]);
  });

  // @gate enableWebMCP
  it('reports required properties when the inputSchema declares none, once per tool', async () => {
    function Bare() {
      useWebMCPTool({
        name: 'bare',
        description: 'No properties.',
        safety: 'read',
        inputSchema: {type: 'object', required: ['sku', 'quantity']},
        execute: () => 'ok',
      });
      return null;
    }
    // A schema that is not an object is not inspected.
    function Untyped() {
      useWebMCPTool({
        name: 'untyped',
        description: 'Untyped.',
        safety: 'read',
        inputSchema: 'any',
        execute: () => 'ok',
      });
      return null;
    }
    await act(() =>
      root.render(
        <>
          <Bare />
          <Untyped />
        </>,
      ),
    );
    // Issues are reported once per tool and rule, so the second undeclared
    // property is folded into the first report.
    assertConsoleErrorDev([
      'The inputSchema of the WebMCP tool "bare" marks "sku" as required ' +
        'but does not declare it in `properties`.' +
        '\n    in Bare (at **)',
    ]);
  });

  // @gate enableWebMCP
  it('warns when a tool does not declare safety, and registers it with no hints', async () => {
    function App() {
      useWebMCPTool({
        name: 'unclassified',
        description: 'No safety.',
        execute: () => 'ok',
      });
      return null;
    }
    await act(() => root.render(<App />));
    assertConsoleWarnDev([
      'The WebMCP tool "unclassified" does not declare `safety`. Agents ' +
        'assume a tool mutates state unless it is marked "read", and ask the ' +
        'user before running one marked "irreversible".' +
        '\n    in App (at **)',
    ]);
    expect(modelContext.tools.get('unclassified').annotations).toEqual({});
    expect(tools()[0].safety).toBe(null);
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
    const first = ReactDOM.unstable_getWebMCPTools();
    expect('ownerToken' in first[0]).toBe(false);

    // Unchanged, the snapshot keeps its identity, so it can back
    // useSyncExternalStore; a re-render that changes nothing is no change.
    seen.length = 0;
    await act(() => root.render(<App />));
    expect(ReactDOM.unstable_getWebMCPTools()).toBe(first);
    expect(seen).toEqual([]);

    unsubscribe();
    await act(() => root.render(null));
    expect(seen).toEqual([]);
    expect(ReactDOM.unstable_getWebMCPTools()).toEqual([]);
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
