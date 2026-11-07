/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {Node} from 'react';
import type {
  PublicToolRecord,
  UseWebMCPToolOptions,
  UseWebMCPToolResult,
} from 'shared/ReactWebMCPTypes';

export type {
  Lifetime,
  PublicToolRecord,
  Safety,
  ToolAnnotations,
  ToolAvailability,
  ToolExecute,
  ToolExecuteClient,
  ToolRecord,
  ToolResponse,
  ToolSource,
  ToolStatus,
  UseWebMCPToolOptions,
  UseWebMCPToolResult,
} from 'shared/ReactWebMCPTypes';
export type {ToolProps, ScopeProps, ToolTreeProps} from './ReactWebMCPToolTree';

// The tool tree comes first on purpose: it loads this package's reconciler,
// and in the monorepo's jest setup the reconciler binds to the host config of
// the renderer entry point required most recently, which must be this one and
// not react-dom.
import {ToolTree, Tool, Scope} from './ReactWebMCPToolTree';
// See ReactWebMCPInternals.js for why the import is untyped.
// $FlowFixMe[cannot-resolve-module]
import * as ReactDOM from 'react-dom';
import * as Noop from './ReactWebMCPNoop';
import {warnMissingReactDOMSupport} from './ReactWebMCPInternals';

export {ToolTree, Tool, Scope};

// The hook path lives in react-dom behind enableWebMCP and is re-exported
// here under its original names, so an app can keep one import for both
// paths. A react-dom without the flag (a stable build) exports them as
// undefined. The no-op stand-ins take their place then, so a tool declared
// through this package registers nothing, the same as the tool tree with
// that react-dom, instead of crashing the component with a TypeError; DEV
// says so once.
const hasHookPath: boolean =
  typeof (ReactDOM as any).unstable_useWebMCPTool === 'function';

export const useWebMCPTool: (
  options: UseWebMCPToolOptions,
) => UseWebMCPToolResult = hasHookPath
  ? (ReactDOM as any).unstable_useWebMCPTool
  : function useWebMCPTool(options: UseWebMCPToolOptions): UseWebMCPToolResult {
      warnMissingReactDOMSupport();
      return Noop.useWebMCPTool(options);
    };

export const ToolScope: (props: {children?: Node, ...}) => Node = hasHookPath
  ? (ReactDOM as any).unstable_WebMCPScope
  : Noop.ToolScope;

export const unstable_getRegisteredTools: () => $ReadOnlyArray<PublicToolRecord> =
  hasHookPath
    ? (ReactDOM as any).unstable_getWebMCPTools
    : Noop.unstable_getRegisteredTools;

export const unstable_subscribeToRegisteredTools: (
  listener: () => void,
) => () => void = hasHookPath
  ? (ReactDOM as any).unstable_subscribeToWebMCPTools
  : Noop.unstable_subscribeToRegisteredTools;
