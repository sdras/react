/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {ReactNodeList} from 'shared/ReactTypes';

import ReactVersion from 'shared/ReactVersion';
import ReactDOMSharedInternals from 'shared/ReactDOMSharedInternals';
import {enableWebMCP} from 'shared/ReactFeatureFlags';

import {isValidContainer} from 'react-dom-bindings/src/client/ReactDOMContainer';
import {createPortal as createPortalImpl} from 'react-reconciler/src/ReactPortal';
import {flushSync} from './ReactDOMFlushSync';

import {
  prefetchDNS,
  preconnect,
  preload,
  preloadModule,
  preinit,
  preinitModule,
} from './ReactDOMFloat';
import {
  requestFormReset,
  useFormStatus,
  useFormState,
} from 'react-dom-bindings/src/shared/ReactDOMFormActions';
import {browser} from './ReactDOMBrowser';
import {useWebMCPTool as useWebMCPToolImpl} from './webmcp/useWebMCPTool';
import {WebMCPScope as WebMCPScopeImpl} from './webmcp/ReactDOMWebMCPToolScope';
import {
  getRegisteredTools as getWebMCPToolsImpl,
  subscribeToRegisteredTools as subscribeToWebMCPToolsImpl,
} from './webmcp/ReactDOMWebMCPRegistry';
import {createWebMCPInternals} from './webmcp/ReactDOMWebMCPInternals';

if (__DEV__) {
  if (
    typeof Map !== 'function' ||
    // $FlowFixMe[prop-missing] Flow incorrectly thinks Map has no prototype
    Map.prototype == null ||
    typeof Map.prototype.forEach !== 'function' ||
    typeof Set !== 'function' ||
    // $FlowFixMe[prop-missing] Flow incorrectly thinks Set has no prototype
    Set.prototype == null ||
    typeof Set.prototype.clear !== 'function' ||
    typeof Set.prototype.forEach !== 'function'
  ) {
    console.error(
      'React depends on Map and Set built-in types. Make sure that you load a ' +
        'polyfill in older browsers. https://reactjs.org/link/react-polyfills',
    );
  }
}

// WebMCP agent tools, experimental. Exported as undefined when the flag is
// off, like `browser`, so the stable build carries neither the code nor the
// behavior. The same handle is published on ReactDOMSharedInternals for
// react-webmcp's tool tree renderer.
if (enableWebMCP) {
  ReactDOMSharedInternals.w = createWebMCPInternals();
}
export const unstable_useWebMCPTool: typeof useWebMCPToolImpl | void =
  enableWebMCP ? useWebMCPToolImpl : undefined;
export const unstable_WebMCPScope: typeof WebMCPScopeImpl | void = enableWebMCP
  ? WebMCPScopeImpl
  : undefined;
export const unstable_getWebMCPTools: typeof getWebMCPToolsImpl | void =
  enableWebMCP ? getWebMCPToolsImpl : undefined;
export const unstable_subscribeToWebMCPTools:
  | typeof subscribeToWebMCPToolsImpl
  | void = enableWebMCP ? subscribeToWebMCPToolsImpl : undefined;

function batchedUpdates<A, R>(fn: (a: A) => R, a: A): R {
  // batchedUpdates is now just a passthrough noop
  return fn(a);
}

function createPortal(
  children: ReactNodeList,
  container: Element | DocumentFragment,
  key: ?string = null,
): React$Portal {
  if (!isValidContainer(container)) {
    throw new Error('Target container is not a DOM element.');
  }

  // TODO: pass ReactDOM portal implementation as third argument
  // $FlowFixMe[incompatible-type] The Flow type is opaque but there's no way to actually create it.
  return createPortalImpl(children, container, null, key);
}

export {
  ReactVersion as version,
  browser,
  createPortal,
  flushSync,
  batchedUpdates as unstable_batchedUpdates,
  prefetchDNS,
  preconnect,
  preload,
  preloadModule,
  preinit,
  preinitModule,
  requestFormReset,
  useFormStatus,
  useFormState,
};
