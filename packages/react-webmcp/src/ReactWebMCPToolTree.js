/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {
  Lifetime,
  ModelContextLike,
  Safety,
  ToolAnnotations,
  ToolExecute,
} from './ReactWebMCPTypes';
import type {Container} from './ReactFiberConfigWebMCP';

import * as React from 'react';
import {LegacyRoot, ConcurrentRoot} from 'react-reconciler/src/ReactRootTags';
import {
  createContainer,
  updateContainerSync,
  injectIntoDevTools,
  flushSyncWork,
  defaultOnUncaughtError,
  defaultOnCaughtError,
  defaultOnRecoverableError,
} from 'react-reconciler/src/ReactFiberReconciler';
import {disableLegacyMode} from 'shared/ReactFeatureFlags';

import {createToolContainer} from './ReactFiberConfigWebMCP';
import {ToolScopeContext} from './ReactWebMCPToolScope';

function defaultOnDefaultTransitionIndicator() {
  // Noop
}

export type ToolProps = {
  // Local tool name; enclosing Scope names are prefixed to it.
  name: string,
  description: string,
  inputSchema?: mixed,
  // Read at call time, so the latest closure always runs.
  execute: ToolExecute,
  safety?: Safety,
  annotations?: ToolAnnotations,
  // Register only while true. Combined with Scope availability and Suspense.
  enabled?: boolean,
  // Stable registry identity. Defaults to the qualified name.
  id?: string,
  lifetime?: Lifetime,
  formatOutput?: (result: mixed, input: mixed) => mixed,
  onError?: (error: mixed) => void,
};

export type ScopeProps = {
  // Prefixes the names of every tool inside.
  name?: string,
  // When false, tools inside are unregistered until it is true again.
  available?: boolean,
  children?: React$Node,
};

// Thin components over the renderer's host elements, so trees read naturally
// in JSX and in React DevTools.
export function Tool(props: ToolProps): React$Node {
  // $FlowFixMe[not-a-component] The tool tree renderer owns this host type.
  return React.createElement('tool', props);
}

export function Scope(props: ScopeProps): React$Node {
  // $FlowFixMe[not-a-component] The tool tree renderer owns this host type.
  return React.createElement('scope', props);
}

export type ToolTreeProps = {
  children?: React$Node,
  // Overrides where tools are registered. Defaults to document.modelContext.
  target?: ?() => ModelContextLike | null,
};

// Bridges a react-dom subtree into a second React root rendered by the tool
// tree renderer, following the pattern react-art uses for <Surface>.
//
// This is a class on purpose. When a Suspense boundary in the DOM tree hides
// this subtree, React calls componentWillUnmount (and componentDidMount again
// when it reappears), which tears down and rebuilds the tool root. That is
// what unregisters tools whose UI is behind a fallback.
export class ToolTree extends React.Component<ToolTreeProps> {
  _container: Container | null;
  _root: any;

  constructor(props: ToolTreeProps) {
    super(props);
    this._container = null;
    this._root = null;
  }

  componentDidMount(): void {
    const container = createToolContainer(this.props.target);
    this._container = container;
    this._root = createContainer(
      container,
      disableLegacyMode ? ConcurrentRoot : LegacyRoot,
      null,
      false,
      false,
      '',
      defaultOnUncaughtError,
      defaultOnCaughtError,
      defaultOnRecoverableError,
      defaultOnDefaultTransitionIndicator,
      null,
    );
    this._renderToolRoot();
  }

  componentDidUpdate(): void {
    this._renderToolRoot();
  }

  componentWillUnmount(): void {
    if (this._root !== null) {
      updateContainerSync(null, this._root, null);
      flushSyncWork();
    }
  }

  _renderToolRoot(): void {
    if (this._root === null) {
      return;
    }
    // Context does not cross renderer roots, so the DOM tree's ToolScope is
    // carried in as props on an implicit root scope. A change flows through
    // commitUpdate like any other prop change.
    const scope = this.context as any;
    const path = scope != null ? scope.path : [];
    const available = scope != null ? scope.available : true;
    // $FlowFixMe[not-a-component] The tool tree renderer owns this host type.
    const rootElement = React.createElement(
      'scope',
      {path, available},
      this.props.children,
    );
    // Commit synchronously so the tool list updates together with the DOM
    // commit that caused it.
    updateContainerSync(rootElement, this._root, null);
    flushSyncWork();
  }

  render(): React$Node {
    return null;
  }
}

ToolTree.contextType = ToolScopeContext;

injectIntoDevTools();
