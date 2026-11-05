/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {WebMCPInternals} from 'shared/ReactWebMCPTypes';

// The webmcp Flow config cannot include react-dom (its fiber config is a
// different renderer), so this import is untyped here; the handle itself is
// typed through shared/ReactWebMCPTypes.
// $FlowFixMe[cannot-resolve-module]
import * as ReactDOM from 'react-dom';

// react-dom publishes its WebMCP registry, scope context and helpers on its
// shared internals when enableWebMCP is on, so the tool tree renderer here
// shares one registry with ReactDOM.unstable_useWebMCPTool. `null` means a
// react-dom without the feature (a stable build): the tree then registers
// nothing, the same as an environment without document.modelContext.
export function getWebMCPInternals(): WebMCPInternals | null {
  const internals: any = (ReactDOM as any)
    .__DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  if (internals == null || internals.w == null) {
    return null;
  }
  return internals.w as WebMCPInternals;
}
