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

## Proposing and reviewing tools

Most of an app's agent tools can be inferred from code it already has: the
handlers that mutate state and the forms that collect input. The inference
assistant in [`infer/`](./infer) proposes them, and the review overlay lets a
developer decide; nothing is registered or written to source without a human
accepting it.

1. `yarn infer-tools extract --src <app source dir>` parses the components
   and writes `tools.proposals.json` next to the source: one proposal per
   handler or form, with a name, a safety classification, an input schema
   derived from the parameters, the code binding (file, line, component,
   handler) and the grounding evidence a reviewer needs. Existing
   `useWebMCPTool` calls and `<Tool>` elements appear as already exported.
2. `yarn infer-tools synthesize --in tools.proposals.json` rewrites the
   placeholder descriptions. The `fixture` provider is deterministic; set
   `REACT_WEBMCP_LLM` or `--provider` to pick another once one exists.
3. Render `<ToolReview>` from `react-webmcp/unstable_review` in development
   and pass it the file's `proposals`. It also lists the tools registered in
   the page right now, so the whole agent-facing surface is in one place.
4. "Export accepted" hands a `ReviewExport` (the accepted proposals with the
   reviewer's edits, plus the rejected ids) to `onExport`, or downloads it as
   `tools.accepted.json`. `yarn infer-tools emit --accepted tools.accepted.json
   --write` then inserts marked `useWebMCPTool` skeletons into the owning
   components for the developer to finish.

```js
import {ToolReview} from 'react-webmcp/unstable_review';
import proposalsFile from './tools.proposals.json';

function DevTools() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Review agent tools</button>
      <ToolReview
        proposals={proposalsFile.proposals}
        open={open}
        onClose={() => setOpen(false)}
        storageKey="my-app"
      />
    </>
  );
}
```

The overlay groups tools by route (or scope, or file), filters by status and
text, shows each proposal's evidence (binding, schema, replay and trace
checks), and lets the reviewer edit the name, description, safety, lifetime and
input schema before accepting. Keyboard: `/` searches, `A` accepts and moves
on, `R` rejects, arrows move, Escape closes. Decisions persist in
`localStorage` under `storageKey` so a reload keeps the reviewer's place;
pass `storageKey={null}` to keep them in memory. The entry is separate from
`react-webmcp` so apps that never render it pay nothing for it.

## Fixture and contract check

`fixtures/webmcp` is a small app that uses both paths and runs against the
monorepo build. `yarn validate-tools` (from the repo root) drives it through
chrome-devtools-mcp and checks that every tool resolves to a component with a
source location, that schemas agree with the parameters `execute` reads, that
names and descriptions stay within the budgets agents tolerate, and that the
tool surface matches the committed `tools.manifest.json`.
