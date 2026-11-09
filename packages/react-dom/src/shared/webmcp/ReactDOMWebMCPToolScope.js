/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {ReactContext} from 'shared/ReactTypes';
import type {ToolScopeContextValue} from 'shared/ReactWebMCPTypes';

import * as React from 'react';

export const ROOT_TOOL_SCOPE: ToolScopeContextValue = {
  path: [],
  available: true,
};

let ToolScopeContext: null | ReactContext<ToolScopeContextValue> = null;

// Created the first time it is asked for. With enableWebMCP on, that is when
// the react-dom entry builds the shared internals, at module evaluation; with
// the flag off nothing asks, so those builds carry no context object. The
// tool tree renderer in react-webmcp reads the same object through
// ReactDOMSharedInternals, which is what lets a DOM-tree scope reach a tool
// tree root.
export function getToolScopeContext(): ReactContext<ToolScopeContextValue> {
  if (ToolScopeContext === null) {
    const context = React.createContext(ROOT_TOOL_SCOPE);
    if (__DEV__) {
      context.displayName = 'WebMCPScope';
    }
    ToolScopeContext = context;
  }
  return ToolScopeContext;
}

type WebMCPScopeProps = {
  // Prefixes the names of every tool inside this scope. Omit it to group
  // tools by availability without renaming them.
  name?: string,
  // When false, tools inside this scope are unregistered until it is true
  // again. Use it while the UI the tools act on is not ready.
  available?: boolean,
  children?: React$Node,
};

export function WebMCPScope({
  name,
  available,
  children,
}: WebMCPScopeProps): React$Node {
  const Context = getToolScopeContext();
  const parent = React.useContext(Context);
  const isAvailable = available !== false;
  const value = React.useMemo(
    () => ({
      path:
        name != null && name !== '' ? parent.path.concat(name) : parent.path,
      available: parent.available && isAvailable,
    }),
    [parent, name, isAvailable],
  );
  return React.createElement(Context.Provider, {value}, children);
}
