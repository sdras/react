/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

// The zero-overhead stand-in for react-webmcp. `react-webmcp/babel` rewrites
// an app's imports of 'react-webmcp' and 'react-webmcp/unstable_review' to
// this module when the project has not opted into WebMCP, so the registry,
// the tool-tree renderer and the review overlay stay out of the bundle while
// the app's code keeps compiling and running unchanged.

import type {Node} from 'react';
import type {
  UseWebMCPToolOptions,
  UseWebMCPToolResult,
} from 'shared/ReactWebMCPTypes';
import type {PublicToolRecord} from 'shared/ReactWebMCPTypes';

const EMPTY_TOOLS: $ReadOnlyArray<PublicToolRecord> = Object.freeze([]);

export function useWebMCPTool(
  options: UseWebMCPToolOptions,
): UseWebMCPToolResult {
  return {
    supported: false,
    registered: false,
    error: null,
    qualifiedName:
      options != null && typeof options.name === 'string' ? options.name : '',
    available: false,
  };
}

export function ToolScope(props: {children?: Node, ...}): Node {
  return props.children === undefined ? null : props.children;
}

export function ToolTree(props: {...}): Node {
  return null;
}

export function Tool(props: {...}): Node {
  return null;
}

export function Scope(props: {...}): Node {
  return null;
}

export function ToolReview(props: {...}): Node {
  return null;
}

export function unstable_getRegisteredTools(): $ReadOnlyArray<PublicToolRecord> {
  return EMPTY_TOOLS;
}

export function unstable_subscribeToRegisteredTools(
  listener: () => void,
): () => void {
  return function unsubscribe() {};
}
