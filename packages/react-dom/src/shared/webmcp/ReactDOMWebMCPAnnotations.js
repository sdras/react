/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {Safety, ToolAnnotations} from 'shared/ReactWebMCPTypes';

// Maps the author-facing `safety` classification onto the WebMCP annotation
// hints. Agents assume a tool mutates state unless `readOnlyHint` says
// otherwise, and browsers ask the user to confirm `consequentialHint` tools.
// Explicit annotations always win over the classification.
export function resolveAnnotations(
  safety: ?Safety,
  annotations: ?ToolAnnotations,
): ToolAnnotations {
  let resolved: ToolAnnotations;
  if (safety === 'read') {
    resolved = {readOnlyHint: true};
  } else if (safety === 'irreversible') {
    resolved = {consequentialHint: true};
  } else {
    resolved = {};
  }
  if (annotations != null) {
    resolved = {...resolved, ...annotations};
  }
  return resolved;
}
