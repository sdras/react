/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import {getTypeTag} from './DevToolsFacadeTreeTools';

import type {Fiber, FiberRoot} from 'react-reconciler/src/ReactInternalTypes';
import type {RendererInternals} from './DevToolsFacade';
import type {
  SourceLocation,
  ToolError,
  TreeTools,
} from './DevToolsFacadeTreeTools';

// Agent tools are WebMCP tools (document.modelContext) that React components
// own through the react-webmcp package. react-webmcp keeps an in-page registry
// of them and, in development builds, exposes it on a well-known global. These
// building blocks read that global and add grounding evidence: which component
// owns each tool and where that component is defined.
//
// The record shape mirrors react-webmcp's ToolRecord (without its owner
// token). Keeping the field names identical lets a manifest of live tools be
// diffed against proposed tools later on.

export type AgentToolSafety = 'read' | 'mutate' | 'irreversible';

export type AgentToolAvailability = {
  enabled: boolean,
  scopeAvailable: boolean,
  hidden: boolean,
  supported: boolean,
};

export type AgentToolOwner = {
  uid: string,
  name: string,
  type: string,
};

export type AgentToolEntry = {
  key: string,
  qualifiedName: string,
  name: string,
  scopePath: $ReadOnlyArray<string>,
  description: string,
  inputSchema: mixed,
  annotations: {[string]: mixed},
  safety: AgentToolSafety | null,
  lifetime: string,
  source: 'hook' | 'tree',
  status: string,
  availability: AgentToolAvailability,
  error: string | null,
  // The component that owns the tool, when it can be resolved.
  owner: AgentToolOwner | null,
  // Where the owner component is defined, when the build carries source info.
  ownerSource: SourceLocation | null,
  unresolvedReason?: string,
};

export type AgentToolsResult = {
  // False when the page does not use react-webmcp, or runs a production build
  // (the registry global is development-only).
  registryFound: boolean,
  tools: Array<AgentToolEntry>,
};

export type AgentTools = {
  getAgentTools: () => AgentToolsResult | ToolError,
};

export const REACT_WEBMCP_REGISTRY_GLOBAL = '__REACT_WEBMCP__';

type FiberMatch = {fiber: Fiber, internals: RendererInternals};

export function createAgentTools(
  fiberRoots: Map<number, Set<FiberRoot>>,
  rendererInternals: Map<number, RendererInternals>,
  treeTools: TreeTools,
  target?: any = globalThis,
): AgentTools {
  // Depth-first walk over every mounted fiber of every renderer. The callback
  // returns true to stop early.
  function findFiber(
    predicate: (fiber: Fiber, internals: RendererInternals) => boolean,
  ): FiberMatch | null {
    let match: FiberMatch | null = null;
    fiberRoots.forEach((roots, rendererID) => {
      if (match !== null) {
        return;
      }
      const internals = rendererInternals.get(rendererID);
      if (internals == null) {
        return;
      }
      roots.forEach(root => {
        if (match !== null) {
          return;
        }
        const stack: Array<Fiber> = [root.current];
        while (stack.length > 0 && match === null) {
          const fiber = stack.pop();
          if (predicate(fiber, internals)) {
            match = {fiber, internals};
            break;
          }
          let child = fiber.child;
          while (child !== null) {
            stack.push(child);
            child = child.sibling;
          }
        }
      });
    });
    return match;
  }

  function isFunctionLike(internals: RendererInternals, fiber: Fiber): boolean {
    const {
      FunctionComponent,
      IncompleteFunctionComponent,
      ForwardRef,
      SimpleMemoComponent,
    } = internals.ReactTypeOfWork;
    return (
      fiber.tag === FunctionComponent ||
      fiber.tag === IncompleteFunctionComponent ||
      fiber.tag === ForwardRef ||
      fiber.tag === SimpleMemoComponent
    );
  }

  // useRef stores the ref object itself as the hook's memoizedState, so a
  // component's hook list can be scanned for a ref by identity.
  function hookListContains(fiber: Fiber, token: mixed): boolean {
    let hook: any = fiber.memoizedState;
    let guard = 0;
    while (hook != null && typeof hook === 'object' && guard < 10000) {
      if (hook.memoizedState === token) {
        return true;
      }
      hook = hook.next;
      guard++;
    }
    return false;
  }

  function getRootFiber(fiber: Fiber): Fiber {
    let node = fiber;
    while (node.return !== null) {
      node = node.return;
    }
    return node;
  }

  function rendererIdOf(fiber: Fiber): number | null {
    const rootFiber = getRootFiber(fiber);
    let found: number | null = null;
    fiberRoots.forEach((roots, rendererID) => {
      if (found !== null) {
        return;
      }
      roots.forEach(root => {
        if (
          root.current === rootFiber ||
          root.current.alternate === rootFiber
        ) {
          found = rendererID;
        }
      });
    });
    return found;
  }

  // A tool rendered through <ToolTree> lives in react-webmcp's own root. Its
  // host fiber's owner chain leads back through the <Tool> wrapper component
  // to the application component that wrote the JSX, which is what a developer
  // wants to see. Walk owners until we leave the tool renderer's roots.
  function resolveTreeOwner(
    hostFiber: Fiber,
    hostRendererId: number | null,
  ): Fiber | null {
    let owner: any = hostFiber._debugOwner;
    let guard = 0;
    while (owner != null && guard < 100) {
      guard++;
      if (typeof owner.tag !== 'number') {
        // Server component info: continue through its owner.
        owner = owner.owner;
        continue;
      }
      if (hostRendererId === null || rendererIdOf(owner) !== hostRendererId) {
        return owner;
      }
      owner = owner._debugOwner;
    }
    return null;
  }

  function describeOwner(
    fiber: Fiber,
    internals: RendererInternals,
  ): AgentToolOwner {
    return {
      uid: treeTools.getUid(fiber),
      name: internals.getDisplayNameForFiber(fiber) || 'Unknown',
      type: getTypeTag(internals.ReactTypeOfWork, fiber.tag),
    };
  }

  function resolveOwner(record: any): {
    owner: AgentToolOwner | null,
    ownerSource: SourceLocation | null,
    unresolvedReason: string | null,
  } {
    const token = record.ownerToken;
    if (token == null) {
      return {
        owner: null,
        ownerSource: null,
        unresolvedReason: 'The tool record has no owner token.',
      };
    }
    let ownerFiber: Fiber | null = null;
    let ownerInternals: RendererInternals | null = null;
    if (record.source === 'tree') {
      const hostMatch = findFiber(fiber => fiber.stateNode === token);
      if (hostMatch === null) {
        return {
          owner: null,
          ownerSource: null,
          unresolvedReason: 'The tool host instance is not mounted.',
        };
      }
      ownerInternals = hostMatch.internals;
      ownerFiber = resolveTreeOwner(
        hostMatch.fiber,
        rendererIdOf(hostMatch.fiber),
      );
      if (ownerFiber === null) {
        return {
          owner: null,
          ownerSource: null,
          unresolvedReason:
            'No owner information is available (production build?).',
        };
      }
    } else {
      const match = findFiber(
        (fiber, internals) =>
          isFunctionLike(internals, fiber) && hookListContains(fiber, token),
      );
      if (match === null) {
        return {
          owner: null,
          ownerSource: null,
          unresolvedReason: 'The owning component is not mounted.',
        };
      }
      ownerFiber = match.fiber;
      ownerInternals = match.internals;
    }
    const owner = describeOwner(ownerFiber, ownerInternals);
    let ownerSource: SourceLocation | null = null;
    try {
      const sourceResult = treeTools.getComponentSource(owner.uid);
      if (sourceResult != null && (sourceResult: any).source != null) {
        ownerSource = (sourceResult: any).source;
      }
    } catch (error) {
      ownerSource = null;
    }
    return {owner, ownerSource, unresolvedReason: null};
  }

  function toEntry(record: any): AgentToolEntry {
    const resolved = resolveOwner(record);
    const entry: AgentToolEntry = {
      key: String(record.key),
      qualifiedName: String(record.qualifiedName),
      name: String(record.name),
      scopePath: Array.isArray(record.scopePath) ? record.scopePath : [],
      description: String(record.description),
      inputSchema: record.inputSchema,
      annotations:
        record.annotations != null && typeof record.annotations === 'object'
          ? record.annotations
          : {},
      safety: record.safety == null ? null : record.safety,
      lifetime: record.lifetime == null ? 'view' : String(record.lifetime),
      source: record.source === 'tree' ? 'tree' : 'hook',
      status: String(record.status),
      availability:
        record.availability != null && typeof record.availability === 'object'
          ? record.availability
          : {
              enabled: true,
              scopeAvailable: true,
              hidden: false,
              supported: true,
            },
      error: record.error == null ? null : String(record.error),
      owner: resolved.owner,
      ownerSource: resolved.ownerSource,
    };
    if (resolved.unresolvedReason !== null) {
      entry.unresolvedReason = resolved.unresolvedReason;
    }
    return entry;
  }

  /**
   * Lists the WebMCP tools React components own through react-webmcp, each
   * with the owning component (uid, name, type) and its source location.
   * Returns {registryFound: false, tools: []} when the page does not expose
   * the react-webmcp registry (no react-webmcp, or a production build).
   */
  function getAgentTools(): AgentToolsResult | ToolError {
    const registry =
      target != null ? target[REACT_WEBMCP_REGISTRY_GLOBAL] : undefined;
    if (registry == null || typeof registry.getTools !== 'function') {
      return {registryFound: false, tools: []};
    }
    let records: Array<any>;
    try {
      const result = registry.getTools();
      records = Array.isArray(result) ? result : [];
    } catch (error) {
      return {
        error: new Error('Failed to read the react-webmcp registry.', {
          cause: error,
        }),
      };
    }
    const tools = records.map(toEntry);
    tools.sort((a, b) =>
      a.qualifiedName < b.qualifiedName
        ? -1
        : a.qualifiedName > b.qualifiedName
          ? 1
          : 0,
    );
    return {registryFound: true, tools};
  }

  return {getAgentTools};
}
