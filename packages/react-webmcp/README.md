# react-webmcp

Derive [WebMCP](https://webmachinelearning.github.io/webmcp/) agent tools from a
React tree.

WebMCP lets a page expose functions as tools that a browser-based AI agent can
discover and call through `document.modelContext`, instead of guessing at the
DOM. In a React app the component that owns a piece of state already owns the
handler an agent would need, so `react-webmcp` lets you declare tools right
there and keeps the browser's tool list in sync with what is on screen.

This package is experimental and only published on the `experimental` release
channel. The WebMCP API itself is behind a flag in Chrome
(`chrome://flags/#enable-webmcp-testing`); everywhere it is absent the package
degrades to a no-op and reports `unsupported`.

## Two ways to declare tools

### The hook: `useWebMCPTool`

Built on [`use-webmcp-tool`](https://www.npmjs.com/package/use-webmcp-tool),
which owns registration, keeps handlers fresh across renders without
re-registering, and normalizes results into MCP responses. `useWebMCPTool` adds
scoped names, `safety`, availability, and a registry for developer tooling.

```js
import {useWebMCPTool, ToolScope} from 'react-webmcp';

function TodoTools({todos, addTodo}) {
  useWebMCPTool({
    name: 'add_todo',
    description: 'Add a new item to the todo list.',
    safety: 'mutate',
    inputSchema: {
      type: 'object',
      properties: {text: {type: 'string', description: 'The todo text.'}},
      required: ['text'],
    },
    execute: ({text}) => {
      addTodo(text);
      return `Added "${text}".`;
    },
  });
  return null;
}

<ToolScope name="todos">
  <TodoTools todos={todos} addTodo={addTodo} />
</ToolScope>;
// The agent sees a tool named "todos_add_todo".
```

Options:

| Option | Meaning |
| --- | --- |
| `name`, `description`, `inputSchema`, `execute` | The tool as WebMCP sees it. `execute(input, {signal})` receives a signal that aborts on unmount. |
| `safety` | `'read'`, `'mutate'` (default) or `'irreversible'`. Maps to the WebMCP `readOnlyHint` / `consequentialHint` annotations. Agents assume a tool mutates state unless told otherwise, and ask the user before running irreversible ones. |
| `annotations` | Explicit WebMCP hints, merged over the ones derived from `safety`. |
| `enabled` | Register only while `true`. |
| `key` | Stable identity in the registry (defaults to the qualified name). |
| `lifetime` | `'app' \| 'route' \| 'view'`, metadata for tooling. |

Returns `{supported, registered, error, qualifiedName, available}`.

`<ToolScope name available>` prefixes the names of the tools inside it and can
mark them unavailable (for example while the data they act on is loading).

### The tree: `<ToolTree>`

A second React root, rendered by this package's own renderer, that turns
`<Tool>` and `<Scope>` elements into registrations in one atomic pass per commit.
Use it when tools should follow Suspense automatically.

```js
import {ToolTree, Scope, Tool} from 'react-webmcp';

<Suspense fallback={<Spinner />}>
  <Inventory />
  <ToolTree>
    <Scope name="cart">
      <Tool
        name="add_item"
        description="Add an inventory item to the cart by SKU."
        safety="mutate"
        inputSchema={{type: 'object', properties: {sku: {type: 'string'}}, required: ['sku']}}
        execute={({sku}) => addToCart(sku)}
      />
    </Scope>
  </ToolTree>
</Suspense>;
```

While the boundary shows its fallback the `cart_*` tools are unregistered; they
come back when the content does. Changing `execute` never re-registers a tool
(the latest closure is read when the agent calls it); changing anything the
agent can observe re-registers exactly once. `<Tool>` accepts the same options
as the hook (`id` instead of `key`); `<Scope name available>` mirrors
`<ToolScope>`.

Why a renderer rather than a hook for this: React keeps a Suspense-hidden tree
mounted and does not run its effects until it is shown again, so a hook cannot
react to the fallback. Host instances of a renderer, and a class component's
`componentWillUnmount`, are told about it directly. Context from the DOM tree
does not cross into the tool root; pass values as props or closures. Text
children are not allowed inside `<ToolTree>`.

## Developer tooling

- Every tool from both paths is mirrored into an in-page registry:
  `unstable_getRegisteredTools()` and `unstable_subscribeToRegisteredTools()`
  work with `useSyncExternalStore`.
- In development the registry is exposed as `globalThis.__REACT_WEBMCP__` so
  React DevTools tooling can read it without importing the app's copy.
  [`react-devtools-cdt-mcp`](../react-devtools-cdt-mcp) exposes it to
  chrome-devtools-mcp as `react_get_agent_tools`, with the owning component and
  its source location for each tool.
- The Components tab of React DevTools shows the tool tree as an extra root and
  each `useWebMCPTool` call's name and status.
- In development the registry warns about duplicate agent-facing names,
  `required` schema properties that are not declared, missing `execute`,
  oversized names and descriptions, and tools without a `safety` classification.

## Fixture and contract check

`fixtures/webmcp` is a small app that uses both paths and runs against the
monorepo build. `yarn validate-tools` (from the repo root) drives it through
chrome-devtools-mcp and checks that every tool resolves to a component with a
source location, that schemas agree with the parameters `execute` reads, that
names and descriptions stay within the budgets agents tolerate, and that the
tool surface matches the committed `tools.manifest.json`.
