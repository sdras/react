/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

// The shared intermediate representation (IR) for React-owned agent tools.
// The same field names are used by the in-page registry, the manifest written
// by the validator, and the `react_get_agent_tools` output, so live tools and
// proposed tools can be diffed against each other.

export type Safety = 'read' | 'mutate' | 'irreversible';

// Metadata only in this release. It is recorded so that later tooling can
// reason about when a tool is expected to exist.
export type Lifetime = 'app' | 'route' | 'view';

export type ToolStatus =
  // The tool is currently registered with the browser.
  | 'registered'
  // The author disabled the tool (`enabled={false}`).
  | 'disabled'
  // The tool's UI is not available right now (suspended or its scope is
  // unavailable), so it is intentionally not exposed to the agent.
  | 'unavailable'
  // `document.modelContext` does not exist in this environment.
  | 'unsupported'
  // Registration failed or the tool definition is invalid.
  | 'error';

export type ToolSource = 'hook' | 'tree';

export type ToolAnnotations = {
  readOnlyHint?: boolean,
  consequentialHint?: boolean,
  untrustedContentHint?: boolean,
  ...
};

export type ToolAvailability = {
  enabled: boolean,
  scopeAvailable: boolean,
  hidden: boolean,
  supported: boolean,
};

export type ToolRecord = {
  // Registry identity. Defaults to the qualified name.
  key: string,
  // The name the agent sees: scope path + local name.
  qualifiedName: string,
  name: string,
  scopePath: $ReadOnlyArray<string>,
  description: string,
  inputSchema: mixed,
  annotations: ToolAnnotations,
  safety: Safety | null,
  lifetime: Lifetime,
  source: ToolSource,
  status: ToolStatus,
  availability: ToolAvailability,
  error: string | null,
  // Hook path: the `useRef` object of the owning component. Tree path: the
  // host instance. Used by developer tooling to find the owner fiber. Stripped
  // from the public snapshot.
  ownerToken: mixed,
};

export type PublicToolRecord = {
  key: string,
  qualifiedName: string,
  name: string,
  scopePath: $ReadOnlyArray<string>,
  description: string,
  inputSchema: mixed,
  annotations: ToolAnnotations,
  safety: Safety | null,
  lifetime: Lifetime,
  source: ToolSource,
  status: ToolStatus,
  availability: ToolAvailability,
  error: string | null,
};

export type ToolExecuteClient = {
  signal: AbortSignal | null,
  ...
};

export type ToolExecute = (input: any, client: ToolExecuteClient) => mixed;

export type ToolResponse = {
  content: Array<{type: string, text?: string, ...}>,
  isError?: boolean,
  ...
};

// The subset of the WebMCP `document.modelContext` surface this package uses.
export type WebMCPToolDescriptor = {
  name: string,
  description: string,
  inputSchema?: mixed,
  annotations?: ToolAnnotations,
  execute: (input: any, client: any) => mixed,
};

export type ModelContextLike = {
  registerTool: (
    tool: WebMCPToolDescriptor,
    options?: {signal?: AbortSignal, ...},
  ) => mixed,
  ...
};
