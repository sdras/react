/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {ToolAnnotations} from 'shared/ReactWebMCPTypes';

// Stringify for messages without ever throwing (JSON.stringify throws on
// circular references and BigInt).
export function safeStringify(value: mixed): string {
  try {
    const result = JSON.stringify(value);
    return result === undefined ? '' : result;
  } catch (x) {
    // eslint-disable-next-line react-internal/safe-string-coercion
    return String(value);
  }
}

// Identity of values JSON cannot represent, so two such values compare equal
// only when they are the same object.
const unserializableIds: WeakMap<interface {}, number> = new WeakMap();
let nextUnserializableId = 1;

// A string that is equal for two values exactly when their JSON forms are.
// Inline objects (`inputSchema`, `annotations`) get a new identity every
// render, so comparisons go by content; a value JSON cannot represent (a
// circular schema, a BigInt) falls back to identity instead of collapsing
// every such value into one string.
export function contentKey(value: mixed): string {
  try {
    const result = JSON.stringify(value);
    return result === undefined ? '' : result;
  } catch (x) {
    if (typeof value === 'object' && value !== null) {
      let id = unserializableIds.get(value);
      if (id === undefined) {
        id = nextUnserializableId++;
        unserializableIds.set(value, id);
      }
      return '[unserializable#' + id + ']';
    }
    // eslint-disable-next-line react-internal/safe-string-coercion
    return String(value);
  }
}

// The agent-facing name of a tool: its scope path joined with its local name.
// Underscores keep the result inside the character set MCP clients accept.
export function resolveQualifiedName(
  path: $ReadOnlyArray<string>,
  name: string,
): string {
  if (path.length === 0) {
    return name;
  }
  return path.join('_') + '_' + name;
}

// Everything an agent can observe about a tool, from the content keys of its
// schema and annotations. For a caller that keeps those keys across renders
// (the hook), so unchanged objects are not serialized again.
export function signatureFromKeys(
  qualifiedName: string,
  description: string,
  inputSchemaKey: string,
  annotationsKey: string,
): string {
  return (
    qualifiedName +
    '\n' +
    description +
    '\n' +
    inputSchemaKey +
    '\n' +
    annotationsKey
  );
}

// Everything an agent can observe about a tool. When the signature is
// unchanged the tool stays registered; `execute` is never part of it because
// handlers are read through a ref at call time.
export function computeSignature(
  qualifiedName: string,
  description: string,
  inputSchema: mixed,
  annotations: ToolAnnotations,
): string {
  return signatureFromKeys(
    qualifiedName,
    description,
    contentKey(inputSchema),
    contentKey(annotations),
  );
}
