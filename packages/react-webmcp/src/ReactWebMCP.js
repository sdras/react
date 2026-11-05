/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

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
export {ToolTree, Tool, Scope} from './ReactWebMCPToolTree';

// The hook path lives in react-dom behind enableWebMCP and is re-exported
// here under its original names, so an app can keep one import for both
// paths. See ReactWebMCPInternals.js for why the import is untyped.
export {
  unstable_useWebMCPTool as useWebMCPTool,
  unstable_WebMCPScope as ToolScope,
  unstable_getWebMCPTools as unstable_getRegisteredTools,
  unstable_subscribeToWebMCPTools as unstable_subscribeToRegisteredTools,
  // $FlowFixMe[cannot-resolve-module]
} from 'react-dom';
