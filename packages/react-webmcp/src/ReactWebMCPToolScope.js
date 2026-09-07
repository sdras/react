/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {ReactContext} from 'shared/ReactTypes';

import * as React from 'react';

export type ToolScopeContextValue = {
  // Scope names from the outermost ToolScope inward. Joined with the tool's
  // local name to form the agent-facing name.
  path: $ReadOnlyArray<string>,
  // False while any enclosing ToolScope is unavailable (for example, while
  // the data behind it is loading).
  available: boolean,
};

export const ROOT_TOOL_SCOPE: ToolScopeContextValue = {
  path: [],
  available: true,
};

export const ToolScopeContext: ReactContext<ToolScopeContextValue> =
  React.createContext(ROOT_TOOL_SCOPE);

type ToolScopeProps = {
  // Prefixes the names of every tool inside this scope. Omit it to group
  // tools by availability without renaming them.
  name?: string,
  // When false, tools inside this scope are unregistered until it is true
  // again. Use it while the UI the tools act on is not ready.
  available?: boolean,
  children?: React$Node,
};

export function ToolScope({
  name,
  available,
  children,
}: ToolScopeProps): React$Node {
  const parent = React.useContext(ToolScopeContext);
  const isAvailable = available !== false;
  const value = React.useMemo(
    () => ({
      path:
        name != null && name !== '' ? parent.path.concat(name) : parent.path,
      available: parent.available && isAvailable,
    }),
    [parent, name, isAvailable],
  );
  return (
    <ToolScopeContext.Provider value={value}>
      {children}
    </ToolScopeContext.Provider>
  );
}
