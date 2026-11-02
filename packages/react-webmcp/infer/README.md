# react-webmcp inference assistant

Proposes WebMCP agent tools from an app's React source, so a developer can
review them instead of writing every tool by hand. It is a developer tool, not
part of the runtime package.

```
yarn infer-tools extract    --src <dir> [--out <file>] [--route-from path|scope|component]
yarn infer-tools synthesize --in <proposals file> [--out <file>] [--provider fixture|anthropic|gemini]
yarn infer-tools emit       --accepted <ReviewExport or proposals file> [--src <dir>] [--write]
```

- `extract` walks `.js/.jsx/.ts/.tsx` under `--src` (skipping `node_modules`,
  `__tests__`, `*.test.*`, `*-test.*` and dotfiles) and writes a
  `tools.proposals.json` (default `<src>/../tools.proposals.json`). Existing
  `useWebMCPTool` calls and `<Tool>` elements are reported as `exported`;
  state-changing handlers and `<form onSubmit>` become `proposed` tools with a
  code binding, a placeholder description and four evidence rows (`binding`,
  `schema`, `replay`, `trace`; the last two stay `pending` until a trace runs).
  Output is byte-identical across runs on unchanged source except the
  timestamps; ids are `<file>#<component>.<handler or L<line>>`.
- `synthesize` rewrites the names and descriptions of `proposed` tools through
  a provider chosen by `--provider` or `REACT_WEBMCP_LLM` (default `fixture`,
  deterministic and offline). `anthropic` and `gemini` are reserved and fail
  with a clear error until implemented; a provider is a
  `{name, synthesize(proposals, context)}` object (see `synthesize.flow.js`).
- `emit` takes the accepted proposals (a `ReviewExport` from the review
  overlay, or a proposals file whose entries were marked `accepted`) and
  inserts a marked `useWebMCPTool` skeleton at the top of each owning
  component, adding the `react-webmcp` import when needed. It prints a unified
  diff by default and only touches files with `--write`. A tool whose name is
  already defined in the file is skipped, so re-running is safe. Forms and
  anonymous handlers get a `TODO` body because they need the developer's
  judgment.

Owner files are resolved against `--src`, or the proposals file's
`source.dir` (relative to the directory the commands are run from, normally
the repo root).

Nothing here publishes a tool. Proposals wait for a person to accept, reject or
edit them in the review overlay (`react-webmcp/unstable_review`), `emit` only
writes skeletons marked `Review before shipping`, and `yarn validate-tools`
remains the contract check for what actually registers.
