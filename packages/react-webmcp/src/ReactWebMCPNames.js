/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {ToolAnnotations} from './ReactWebMCPTypes';

// Stringify for signatures and messages without ever throwing
// (JSON.stringify throws on circular references and BigInt).
export function safeStringify(value: mixed): string {
  try {
    const result = JSON.stringify(value);
    return result === undefined ? '' : result;
  } catch (x) {
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

// Everything an agent can observe about a tool. When the signature is
// unchanged the tool stays registered; `execute` is never part of it because
// handlers are read through the instance at call time.
export function computeSignature(
  qualifiedName: string,
  description: string,
  inputSchema: mixed,
  annotations: ToolAnnotations,
): string {
  return (
    qualifiedName +
    '\n' +
    description +
    '\n' +
    safeStringify(inputSchema) +
    '\n' +
    safeStringify(annotations)
  );
}
