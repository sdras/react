/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {ToolResponse} from './ReactWebMCPTypes';

import {safeStringify} from './ReactWebMCPNames';

// Normalizes whatever a tool's `execute` returns into an MCP tool result. This
// mirrors the `use-webmcp-tool` hook so both authoring paths hand the agent
// the same shapes:
//   string             -> {content: [{type: 'text', text}]}
//   undefined / null   -> {content: []}
//   {content: [...]}   -> passed through untouched
//   anything else      -> JSON-serialized into a text block
export function normalizeToolResult(value: mixed): ToolResponse {
  if (
    value !== null &&
    typeof value === 'object' &&
    Array.isArray((value as any).content)
  ) {
    return value as any;
  }
  if (value === undefined || value === null) {
    return {content: []};
  }
  if (typeof value === 'string') {
    return {content: [{type: 'text', text: value}]};
  }
  return {content: [{type: 'text', text: safeStringify(value)}]};
}

// Every failure becomes an explicit `isError` result, whatever was thrown. A
// thrown string or plain object must never read as success to the agent.
export function normalizeToolError(error: mixed): ToolResponse {
  let text;
  if (error instanceof Error) {
    text = error.message;
  } else if (typeof error === 'string') {
    text = error;
  } else {
    text = safeStringify(error);
  }
  return {content: [{type: 'text', text}], isError: true};
}
