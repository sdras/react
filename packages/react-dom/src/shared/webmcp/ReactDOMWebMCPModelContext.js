/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {ModelContextLike} from 'shared/ReactWebMCPTypes';

// WebMCP exposes the imperative API on `document.modelContext`. It is absent
// on the server, in browsers without the feature, and before a browser
// extension injects a polyfill, so every read goes through this check.
export function getModelContext(): ModelContextLike | null {
  if (typeof document === 'undefined') {
    return null;
  }
  const modelContext = (document as any).modelContext;
  if (modelContext == null || typeof modelContext.registerTool !== 'function') {
    return null;
  }
  return modelContext as ModelContextLike;
}
