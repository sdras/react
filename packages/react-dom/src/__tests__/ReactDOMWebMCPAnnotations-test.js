/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails react-core
 */

'use strict';

let resolveAnnotations;
let resolveQualifiedName;
let computeSignature;
let safeStringify;

describe('ReactDOM WebMCP annotations and names', () => {
  beforeEach(() => {
    jest.resetModules();
    ({
      resolveAnnotations,
    } = require('react-dom/src/shared/webmcp/ReactDOMWebMCPAnnotations'));
    ({
      resolveQualifiedName,
      computeSignature,
      safeStringify,
    } = require('react-dom/src/shared/webmcp/ReactDOMWebMCPNames'));
  });

  it('maps safety onto WebMCP annotation hints', () => {
    expect(resolveAnnotations('read', undefined)).toEqual({readOnlyHint: true});
    expect(resolveAnnotations('irreversible', undefined)).toEqual({
      consequentialHint: true,
    });
    expect(resolveAnnotations('mutate', undefined)).toEqual({});
    expect(resolveAnnotations(null, undefined)).toEqual({});
    expect(resolveAnnotations(undefined, undefined)).toEqual({});
  });

  it('lets explicit annotations win over the safety classification', () => {
    expect(
      resolveAnnotations('read', {
        readOnlyHint: false,
        untrustedContentHint: true,
      }),
    ).toEqual({readOnlyHint: false, untrustedContentHint: true});
    expect(resolveAnnotations('mutate', {consequentialHint: true})).toEqual({
      consequentialHint: true,
    });
  });

  it('joins scope paths and names with underscores', () => {
    expect(resolveQualifiedName([], 'add_item')).toBe('add_item');
    expect(resolveQualifiedName(['cart'], 'add_item')).toBe('cart_add_item');
    expect(resolveQualifiedName(['shop', 'cart'], 'add')).toBe('shop_cart_add');
  });

  it('computes a signature from everything the agent can observe', () => {
    const a = computeSignature('x', 'desc', {type: 'object'}, {});
    const sameContent = computeSignature('x', 'desc', {type: 'object'}, {});
    const differentSchema = computeSignature('x', 'desc', {type: 'string'}, {});
    const differentAnnotations = computeSignature(
      'x',
      'desc',
      {type: 'object'},
      {readOnlyHint: true},
    );
    expect(a).toBe(sameContent);
    expect(a).not.toBe(differentSchema);
    expect(a).not.toBe(differentAnnotations);
  });

  it('never throws while stringifying', () => {
    const circular = {};
    circular.self = circular;
    expect(typeof safeStringify(circular)).toBe('string');
    expect(safeStringify(undefined)).toBe('');
    expect(safeStringify({a: 1})).toBe('{"a":1}');
  });
});
