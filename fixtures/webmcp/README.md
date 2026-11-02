# react-webmcp fixture

A small React app that derives WebMCP agent tools from its component tree with
[`react-webmcp`](../../packages/react-webmcp). It exercises both authoring
paths and doubles as the target of the `react-webmcp` contract check
(`yarn validate-tools` from the repo root).

- **Todos** register tools with the `useWebMCPTool` hook inside
  `<ToolScope name="todos">`, including a scope that becomes unavailable while a
  fake search index loads and a toggle that mounts a duplicate tool name to show
  the DEV warning.
- **Cart** renders `<ToolTree>` inside a `<Suspense>` boundary, so the `cart_*`
  tools are unregistered while the inventory loads or while "Suspend cart" is on.
- **Registered tools** lists the in-page registry as the app sees it.

Like `react-devtools-shell`, React and `react-webmcp` are resolved from the
monorepo build output via webpack aliases, so the fixture runs against React
from source. `react-devtools-cdt-mcp/register` is imported first, so the page's
React tools (including `react_get_agent_tools`) are discoverable by
[chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp).

## Run

1. Build React for DevTools from the repo root (populates
   `build/oss-experimental/`, including `react-webmcp`):

   ```sh
   yarn build-for-devtools
   ```

2. Install and start the fixture:

   ```sh
   cd fixtures/webmcp
   yarn
   yarn start
   ```

   This opens `http://localhost:8080/`.

3. To see the tools as an agent does, use a Chrome build with WebMCP:
   enable `chrome://flags/#enable-webmcp-testing` and
   `chrome://flags/#devtools-webmcp-support`, reload, and open
   DevTools → Application → WebMCP. Run a tool from the pane and watch the app
   update; click "Suspend cart" and watch the `cart_*` tools disappear.

   Without those flags a shim stands in for `document.modelContext`, so the
   "Registered tools" panel still works and the contract check can run
   headlessly.

4. React DevTools shows a second root for the tool tree and the
   `useWebMCPTool` debug values in the Components tab.

## Review proposed tools

The "Review agent tools" button opens the review overlay from
`react-webmcp/unstable_review` over the app, loaded with
`tools.proposals.json`. That file is generated; regenerate it after changing
the fixture's components:

```sh
yarn infer-tools extract --src fixtures/webmcp/src --out fixtures/webmcp/tools.proposals.json
yarn infer-tools synthesize --in fixtures/webmcp/tools.proposals.json
yarn infer-tools trace --in fixtures/webmcp/tools.proposals.json --journey fixtures/webmcp/journeys/shop.json
```

The last command needs Node 22.12 or newer (see below). `journeys/shop.json`
fills the todo form, calls the cart tools, and toggles "Suspend cart", so the
proposals carry mounted, replay and trace evidence. Source locations in the
overlay open in VS Code; change `editor` in `src/App.js` for another editor.

The seven tools the fixture already registers show up as exported; the other
proposals come from its handlers and its form. Accept or reject them, then
"Export accepted" downloads `tools.accepted.json`, which
`yarn infer-tools emit --accepted <that file> --src fixtures/webmcp/src`
turns into a diff (add `--write` to apply it). Decisions are remembered in
`localStorage` under `fixtures/webmcp`.

## Contract check

With the build in place, from the repo root (the check drives
[chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp),
which needs Node 20.19, 22.12 or newer):

```sh
yarn validate-tools --update   # first run: write fixtures/webmcp/tools.manifest.json
yarn validate-tools            # afterwards: fail on drift, missing owners, or schema mismatches
```
