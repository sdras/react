/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {Facade} from './DevToolsFacade';
import type {AgentToolsResult} from './DevToolsFacadeAgentTools';
import type {
  TreeNode,
  NodeInfo,
  ComponentSource,
  OwnersStack,
  ParentEntry,
  OwnerEntry,
  FindComponentsResult,
  ToolError,
} from './DevToolsFacadeTreeTools';
import type {
  StartProfilingResult,
  StopProfilingResult,
  TraceOverviewRow,
  CommitReport,
} from './DevToolsFacadeProfilerTools';

import {enableWebMCP} from 'shared/ReactFeatureFlags';

import {createTreeTools} from './DevToolsFacadeTreeTools';
import {createAgentTools} from './DevToolsFacadeAgentTools';
import {createProfilerTools} from './DevToolsFacadeProfilerTools';

export type {
  TreeNode,
  NodeInfo,
  HookNode,
  ComponentSource,
  SourceLocation,
  OwnersStack,
  ComponentBranchEntry,
  ParentEntry,
  OwnerEntry,
  FindComponentsResult,
  ToolError,
} from './DevToolsFacadeTreeTools';
export type {
  AgentToolEntry,
  AgentToolOwner,
  AgentToolsResult,
} from './DevToolsFacadeAgentTools';
export type {
  CommitComponent,
  TraceOverviewRow,
  CommitReport,
  StartProfilingResult,
  StopProfilingResult,
} from './DevToolsFacadeProfilerTools';

// The set of tools assembled from a Facade. Each tool returns a plain
// JavaScript value (see the types in ./DevToolsFacadeTreeTools and
// ./DevToolsFacadeProfilerTools); serialization is the integrator's responsibility.
// Integrators decide whether to expose these on globals or call them directly.
export type Tools = {
  getComponentTree: (
    depth?: number,
    rootUid?: string,
  ) => Array<TreeNode> | ToolError,
  getComponentByUid: (
    uid: string,
    includeHooks?: boolean,
  ) => NodeInfo | ToolError,
  getComponentByHostInstance: (hostInstance: mixed) => NodeInfo | ToolError,
  findComponents: (
    name: string,
    rootUid?: string,
    page?: number,
    pageSize?: number,
  ) => FindComponentsResult | ToolError,
  getComponentSource: (uid: string) => ComponentSource | ToolError,
  getOwnerStackTrace: (uid: string) => OwnersStack | ToolError,
  getParentStack: (uid: string) => Array<ParentEntry> | ToolError,
  getOwnerStack: (uid: string) => Array<OwnerEntry> | ToolError,
  startProfiling: (traceName?: string) => StartProfilingResult | ToolError,
  stopProfiling: () => StopProfilingResult | ToolError,
  getTraceOverview: (traceName: string) => Array<TraceOverviewRow> | ToolError,
  getCommitReport: (
    traceName: string,
    commitIndex: number,
  ) => CommitReport | ToolError,
  // WebMCP agent tools ship behind React's enableWebMCP flag (the experimental
  // channel). Like ReactDOM.unstable_useWebMCPTool, this is undefined in a
  // build without the flag, so integrators can feature-detect it.
  getAgentTools: (() => AgentToolsResult | ToolError) | void,
};

/**
 * Assemble the set of tools from a Facade. The tools read the facade's tracked
 * runtime state (fiber roots, per-renderer internals, profiling state) lazily
 * on each call and never touch globals, so the integrator fully owns both the
 * facade and the returned tools. Profiler tools share the tree tools' getUid
 * so component uids are consistent across all tools.
 *
 * @param facade - A Facade returned by installFacade().
 */
export function createTools(facade: Facade): Tools {
  const tree = createTreeTools(facade.fiberRoots, facade.rendererInternals);
  const profiler = createProfilerTools(
    facade.rendererInternals,
    facade.profilingState,
    tree.getUid,
  );
  const agent = enableWebMCP
    ? createAgentTools(facade.fiberRoots, facade.rendererInternals, tree)
    : null;

  return {
    getComponentTree: tree.getComponentTree,
    getComponentByUid: tree.getComponentByUid,
    getComponentByHostInstance: tree.getComponentByHostInstance,
    findComponents: tree.findComponents,
    getComponentSource: tree.getComponentSource,
    getOwnerStackTrace: tree.getOwnerStackTrace,
    getParentStack: tree.getParentStack,
    getOwnerStack: tree.getOwnerStack,
    startProfiling: profiler.startProfiling,
    stopProfiling: profiler.stopProfiling,
    getTraceOverview: profiler.getTraceOverview,
    getCommitReport: profiler.getCommitReport,
    getAgentTools: agent !== null ? agent.getAgentTools : undefined,
  };
}
