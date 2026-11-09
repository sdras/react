/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {ReactContext} from 'shared/ReactTypes';

// The shared intermediate representation (IR) for React-owned WebMCP agent
// tools. The same field names are used by the registry in react-dom, the tool
// tree renderer in react-webmcp, the manifest written by the contract check,
// and the `react_get_agent_tools` output, so live tools and proposed tools can
// be diffed against each other. Types only: this file is visible to every
// renderer's Flow config.

export type Safety = 'read' | 'mutate' | 'irreversible';

// Metadata only in this release. It is recorded so that later tooling can
// reason about when a tool is expected to exist.
export type Lifetime = 'app' | 'route' | 'view';

export type ToolStatus =
  // React has registered the tool with the browser, or is registering it: a
  // refusal turns this into 'error'.
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
  safety: null | Safety,
  lifetime: Lifetime,
  source: ToolSource,
  status: ToolStatus,
  availability: ToolAvailability,
  error: null | string,
  // Registry identity of the writer. Hook path: the `useRef` object of the
  // owning component. Tree path: the host instance. Used by developer tooling
  // to find the owner fiber. Stripped from the public snapshot.
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
  safety: null | Safety,
  lifetime: Lifetime,
  source: ToolSource,
  status: ToolStatus,
  availability: ToolAvailability,
  error: null | string,
};

export type ToolExecuteClient = {
  signal: null | AbortSignal,
  ...
};

export type ToolExecute = (input: any, client: ToolExecuteClient) => mixed;

export type ToolResponse = {
  content: Array<{type: string, text?: string, ...}>,
  isError?: boolean,
  ...
};

// The subset of the WebMCP `document.modelContext` surface React uses.
export type WebMCPToolDescriptor = {
  name: string,
  description: string,
  inputSchema?: mixed,
  annotations?: ToolAnnotations,
  // The browser's input is untyped. Polyfills may call without a client.
  execute: (input: mixed, client: ?ToolExecuteClient) => mixed,
};

export type ModelContextLike = {
  // Returns nothing when it accepts synchronously; a browser that decides
  // asynchronously returns a promise that rejects on refusal.
  registerTool: (
    tool: WebMCPToolDescriptor,
    options?: {signal?: AbortSignal, ...},
  ) => void | Promise<void>,
  ...
};

export type ToolScopeContextValue = {
  // Scope names from the outermost scope inward. Joined with the tool's
  // local name to form the agent-facing name.
  path: $ReadOnlyArray<string>,
  // False while any enclosing scope is unavailable (for example, while the
  // data behind it is loading).
  available: boolean,
};

export type UseWebMCPToolOptions = {
  // Local tool name; the enclosing scope names are prefixed to it.
  name: string,
  description: string,
  inputSchema?: mixed,
  // Receives the agent's input and {signal}; the signal aborts when the
  // browser cancels the call or when the tool is unregistered.
  execute: ToolExecute,
  // Stable identity in the registry. Defaults to the qualified name.
  key?: string,
  // Drives the WebMCP annotation hints. Agents assume mutation by default.
  safety?: Safety,
  lifetime?: Lifetime,
  // Explicit hints, merged over the ones derived from `safety`.
  annotations?: ToolAnnotations,
  // Register only while true. Combined with the scope availability.
  enabled?: boolean,
  formatOutput?: (result: mixed, input: mixed) => mixed,
  onError?: (error: mixed) => void,
};

export type UseWebMCPToolResult = {
  // `document.modelContext` exists in this environment.
  supported: boolean,
  // The tool is enabled and the browser has accepted its current definition
  // from this hook. Registration is a layout effect, so a new definition is
  // false in the render that leads to it and true from the re-render that
  // follows the browser's acceptance, and a definition the browser refused
  // stays false. A definition accepted earlier (re-enabled, or revealed after
  // a Suspense or Activity hide) is true in the render that registers it
  // again; a refusal then corrects it before paint.
  registered: boolean,
  error: null | Error,
  // The name the agent sees, including scope prefixes.
  qualifiedName: string,
  // Whether the tool is meant to be exposed right now.
  available: boolean,
};

// What react-dom hands other packages through ReactDOMSharedInternals (the
// `w` field) so the tool tree renderer in react-webmcp shares one registry,
// one scope context and one set of helpers with the hook. Short keys follow
// the convention of the other internals; they are not public API.
export type WebMCPInternals = {
  // upsertToolRecord: writes the owner's record, returns whether it changed
  u: (record: ToolRecord) => boolean,
  // removeToolRecord, by owner
  r: (ownerToken: mixed) => void,
  // getToolRecord, by owner
  g: (ownerToken: mixed) => ToolRecord | void,
  // checkToolRecordCollisions (DEV): report other owners of this owner's key
  v: (ownerToken: mixed) => void,
  // batchToolRecordUpdates
  b: <T>(fn: () => T) => T,
  // The scope context shared by unstable_WebMCPScope and the tool tree.
  c: ReactContext<ToolScopeContextValue>,
  // resolveQualifiedName
  n: (path: $ReadOnlyArray<string>, name: string) => string,
  // computeSignature
  k: (
    qualifiedName: string,
    description: string,
    inputSchema: mixed,
    annotations: ToolAnnotations,
  ) => string,
  // resolveAnnotations
  a: (safety: ?Safety, annotations: ?ToolAnnotations) => ToolAnnotations,
  // normalizeToolResult
  o: (value: mixed) => ToolResponse,
  // normalizeToolError
  e: (error: mixed) => ToolResponse,
  // getModelContext
  m: () => null | ModelContextLike,
  // safeStringify, for messages
  j: (value: mixed) => string,
  // contentKey, for comparisons
  h: (value: mixed) => string,
  // combineAbortSignals
  s: (
    client: null | AbortSignal,
    lifetime: null | AbortSignal,
  ) => null | AbortSignal,
};
