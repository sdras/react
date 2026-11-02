# react-webmcp inference assistant

Proposes WebMCP agent tools from an app's React source, so a developer can
review them instead of writing every tool by hand. It is a developer tool, not
part of the runtime package.

```
yarn infer-tools extract    --src <dir> [--out <file>] [--route-from path|scope|component]
yarn infer-tools synthesize --in <proposals file> [--out <file>] [--provider fixture|anthropic|gemini]
yarn infer-tools trace      --in <proposals file> [--out <file>] [--url <app>] [--journey <file>]...
yarn infer-tools emit       --accepted <ReviewExport or proposals file> [--src <dir>] [--write]
                            [--evals <dir>] [--force-evals]
```

- `extract` walks `.js/.jsx/.ts/.tsx` under `--src` (skipping `node_modules`,
  `__tests__`, `*.test.*`, `*-test.*` and dotfiles) and writes a
  `tools.proposals.json` (default `<src>/../tools.proposals.json`). Existing
  `useWebMCPTool` calls and `<Tool>` elements are reported as `exported`;
  state-changing handlers and `<form onSubmit>` become `proposed` tools with a
  code binding, a placeholder description and evidence rows: `binding`,
  `schema` (a warning per form input that had to be named after its id,
  aria-label, label or placeholder), `intent` (a warning when the handler
  only flips UI state, such as opening a dialog), and `replay` and `trace`,
  which stay `pending` until a trace runs. Submission forms are mutations
  unless the name carries a consequential object (order, payment, checkout).
  Output is byte-identical across runs on unchanged source except the
  timestamps; ids are `<file>#<component>.<handler or L<line>>`.
- `synthesize` rewrites the names and descriptions of `proposed` tools through
  a provider chosen by `--provider` or `REACT_WEBMCP_LLM` (default `fixture`,
  deterministic and offline). `anthropic` calls Claude through the official
  SDK (`ANTHROPIC_API_KEY` or an `ant auth login` profile; model
  `claude-opus-5-5`, override with `REACT_WEBMCP_ANTHROPIC_MODEL`; the
  server-side refusal fallback is on unless
  `REACT_WEBMCP_ANTHROPIC_FALLBACKS=off`). `gemini` calls the generateContent
  REST API (`GEMINI_API_KEY`; model `gemini-2.5-flash`, override with
  `REACT_WEBMCP_GEMINI_MODEL`). Both send each batch of candidates with the
  source around their bindings and ask for a JSON list of suggestions; a
  suggestion that breaks the naming rules is dropped with a warning. A
  provider is a `{name, synthesize(proposals, context)}` object (see
  `synthesize.flow.js`).
- `trace` opens the fixture (or `--url`) in headless Chrome through
  chrome-devtools-mcp, the same way `yarn validate-tools` does, and records
  whether each owning component is mounted and what the registered read-only
  tools return. With `--journey`, it also drives the page through the steps in
  a journey file (`{"name", "steps": [{"fill", "value"}, {"click", "near"?},
  {"tool", "input"?}, {"wait"}]}`), maps each click to the components that own
  the element and the handler that ran, and writes `trace` evidence per
  proposal plus `replay` evidence for tools the journey calls, mutating ones
  included. The review overlay's "Record journey" button writes journey files
  from what you do on the page; add `tool` steps by hand. Needs Node 20.19,
  22.12 or newer.
- `emit` takes the accepted proposals (a `ReviewExport` from the review
  overlay, or a proposals file whose entries were marked `accepted`) and
  inserts a marked `useWebMCPTool` skeleton at the top of each owning
  component, adding the `react-webmcp` import when needed. It prints a unified
  diff by default and only touches files with `--write`. A tool whose name is
  already defined in the file is skipped, so re-running is safe. Forms and
  anonymous handlers get a `TODO` body because they need the developer's
  judgment. `--evals <dir>` also writes one evals-cli skeleton per accepted
  tool (`{messages, expectedCall}` with placeholder arguments) plus a README;
  existing eval files are kept unless `--force-evals` is passed.

Owner files are resolved against `--src`, or the proposals file's
`source.dir` (relative to the directory the commands are run from, normally
the repo root).

Nothing here publishes a tool. Proposals wait for a person to accept, reject or
edit them in the review overlay (`react-webmcp/unstable_review`), `emit` only
writes skeletons marked `Review before shipping`, and `yarn validate-tools`
remains the contract check for what actually registers.
