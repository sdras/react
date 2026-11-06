/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {WebMCPInternals} from 'shared/ReactWebMCPTypes';

import {resolveAnnotations} from './ReactDOMWebMCPAnnotations';
import {getModelContext} from './ReactDOMWebMCPModelContext';
import {
  computeSignature,
  contentKey,
  resolveQualifiedName,
  safeStringify,
} from './ReactDOMWebMCPNames';
import {
  normalizeToolError,
  normalizeToolResult,
} from './ReactDOMWebMCPNormalize';
import {
  batchToolRecordUpdates,
  checkToolRecordCollisions,
  getToolRecord,
  removeToolRecord,
  upsertToolRecord,
} from './ReactDOMWebMCPRegistry';
import {combineAbortSignals} from './ReactDOMWebMCPSignal';
import {getToolScopeContext} from './ReactDOMWebMCPToolScope';

// The handle react-dom publishes on ReactDOMSharedInternals (`w`) when
// enableWebMCP is on. react-webmcp's tool tree renderer registers through it
// so there is one registry and one scope context per page, whichever path
// declared the tool.
export function createWebMCPInternals(): WebMCPInternals {
  return {
    u: upsertToolRecord,
    r: removeToolRecord,
    g: getToolRecord,
    v: checkToolRecordCollisions,
    b: batchToolRecordUpdates,
    c: getToolScopeContext(),
    n: resolveQualifiedName,
    k: computeSignature,
    a: resolveAnnotations,
    o: normalizeToolResult,
    e: normalizeToolError,
    m: getModelContext,
    j: safeStringify,
    h: contentKey,
    s: combineAbortSignals,
  };
}
