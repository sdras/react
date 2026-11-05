/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {EventPriority} from 'react-reconciler/src/ReactEventPriorities';
import type {HostDispatcher} from './shared/ReactDOMTypes';
import type {WebMCPInternals} from 'shared/ReactWebMCPTypes';

import noop from 'shared/noop';

// This should line up with NoEventPriority from react-reconciler/src/ReactEventPriorities
// but we can't depend on the react-reconciler from this isomorphic code.
export const NoEventPriority: EventPriority = 0 as any;

type ReactDOMInternals = {
  d /* ReactDOMCurrentDispatcher */: HostDispatcher,
  p /* currentUpdatePriority */: EventPriority,
  findDOMNode:
    | null
    | ((componentOrElement: component(...props: any)) => null | Element | Text),
  // The WebMCP tool registry and helpers, set by the react-dom entry when
  // enableWebMCP is on, so react-webmcp's tool tree shares them with
  // unstable_useWebMCPTool.
  w /* WebMCP */: null | WebMCPInternals,
};

function requestFormReset(element: HTMLFormElement) {
  throw new Error(
    'Invalid form element. requestFormReset must be passed a form that was ' +
      'rendered by React.',
  );
}

const DefaultDispatcher: HostDispatcher = {
  f /* flushSyncWork */: noop,
  r /* requestFormReset */: requestFormReset,
  D /* prefetchDNS */: noop,
  C /* preconnect */: noop,
  L /* preload */: noop,
  m /* preloadModule */: noop,
  X /* preinitScript */: noop,
  S /* preinitStyle */: noop,
  M /* preinitModuleScript */: noop,
};

const Internals: ReactDOMInternals = {
  d /* ReactDOMCurrentDispatcher */: DefaultDispatcher,
  p /* currentUpdatePriority */: NoEventPriority,
  findDOMNode: null,
  w /* WebMCP */: null,
};

export default Internals;
