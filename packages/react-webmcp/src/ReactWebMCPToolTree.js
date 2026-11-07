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
} from 'shared/ReactWebMCPTypes';
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

import {
  createToolContainer,
  flushPendingCollisionChecks,
} from './ReactFiberConfigWebMCP';
import {
  getWebMCPInternals,
  warnMissingReactDOMSupport,
} from './ReactWebMCPInternals';

const {useContext, useEffect, useLayoutEffect, useRef} = React;

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

type ToolRoot = {
  container: Container,
  root: any,
};

// The DOM tree's unstable_WebMCPScope context, shared through react-dom's
// internals so a <ToolTree> inherits the scope of the components around it.
// Without an experimental react-dom the tree registers nothing, so any
// context object will do.
const webMCPInternals = getWebMCPInternals();
const ScopeContext =
  webMCPInternals !== null
    ? webMCPInternals.c
    : React.createContext({path: [], available: true});

// Commits the tool root synchronously, so the tool list updates together
// with the DOM commit that caused it.
function renderToolRoot(toolRoot: ToolRoot, element: React$Node): void {
  const container = toolRoot.container;
  container.inHostCommit = true;
  try {
    updateContainerSync(element, toolRoot.root, null);
    flushSyncWork();
  } finally {
    container.inHostCommit = false;
  }
}

// Bridges a react-dom subtree into a second React root rendered by the tool
// tree renderer, following the pattern react-art uses for <Surface>.
//
// The root lives in layout effects on purpose. When a Suspense boundary in
// the DOM tree hides this subtree, React disconnects its layout effects (and
// reconnects them when it reappears), which tears down and rebuilds the tool
// root. That is what unregisters tools whose UI is behind a fallback.
export function ToolTree(props: ToolTreeProps): React$Node {
  const {children, target} = props;
  // Context does not cross renderer roots, so the DOM tree's ToolScope is
  // carried in as props on an implicit root scope. A change flows through
  // commitUpdate like any other prop change.
  const scope = useContext(ScopeContext);
  const path = scope != null ? scope.path : [];
  const available = scope != null ? scope.available : true;

  const toolRootRef = useRef<ToolRoot | null>(null);

  // `target` is read once, when the root is created.
  const targetRef = useRef(target);
  useLayoutEffect(() => {
    const internals = getWebMCPInternals();
    if (internals === null) {
      warnMissingReactDOMSupport();
    }
    const container = createToolContainer(targetRef.current, internals);
    const root = createContainer(
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
    const toolRoot = {container, root};
    toolRootRef.current = toolRoot;
    return () => {
      toolRootRef.current = null;
      renderToolRoot(toolRoot, null);
    };
  }, []);

  useLayoutEffect(() => {
    const toolRoot = toolRootRef.current;
    if (toolRoot === null) {
      return;
    }
    // $FlowFixMe[not-a-component] The tool tree renderer owns this host type.
    const rootElement = React.createElement(
      'scope',
      {path, available},
      children,
    );
    renderToolRoot(toolRoot, rootElement);
  });

  // DEV: key collision checks for records the tool root wrote during this
  // commit run after it settles, when a component the commit unmounted has
  // removed its record (see flushToolTree).
  useEffect(() => {
    if (__DEV__) {
      const toolRoot = toolRootRef.current;
      if (toolRoot !== null) {
        flushPendingCollisionChecks(toolRoot.container);
      }
    }
  });

  return null;
}

injectIntoDevTools();
