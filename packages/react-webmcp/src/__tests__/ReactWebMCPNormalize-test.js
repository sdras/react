/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails react-core
 */

'use strict';

let normalizeToolResult;
let normalizeToolError;

describe('ReactWebMCP result normalization', () => {
  beforeEach(() => {
    jest.resetModules();
    ({
      normalizeToolResult,
      normalizeToolError,
    } = require('react-webmcp/src/ReactWebMCPNormalize'));
  });

  it('wraps strings in a text block', () => {
    expect(normalizeToolResult('done')).toEqual({
      content: [{type: 'text', text: 'done'}],
    });
  });

  it('treats undefined and null as an empty success', () => {
    expect(normalizeToolResult(undefined)).toEqual({content: []});
    expect(normalizeToolResult(null)).toEqual({content: []});
  });

  it('passes well-formed MCP results through untouched', () => {
    const result = {content: [{type: 'text', text: 'x'}], isError: false};
    expect(normalizeToolResult(result)).toBe(result);
  });

  it('serializes other values as JSON text', () => {
    expect(normalizeToolResult({items: [1, 2]})).toEqual({
      content: [{type: 'text', text: '{"items":[1,2]}'}],
    });
    expect(normalizeToolResult(42)).toEqual({
      content: [{type: 'text', text: '42'}],
    });
  });

  it('turns any thrown value into an isError result', () => {
    expect(normalizeToolError(new Error('boom'))).toEqual({
      content: [{type: 'text', text: 'boom'}],
      isError: true,
    });
    expect(normalizeToolError('not signed in')).toEqual({
      content: [{type: 'text', text: 'not signed in'}],
      isError: true,
    });
    expect(normalizeToolError({code: 403})).toEqual({
      content: [{type: 'text', text: '{"code":403}'}],
      isError: true,
    });
  });
});
