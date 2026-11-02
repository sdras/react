/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails react-core
 */

'use strict';

const {applyTrace, parseTraceArgs} = require('../trace.flow');

function proposal(overrides) {
  return {
    id: 'src/Cart.js#Cart.addItem',
    name: 'add_item',
    qualifiedName: 'cart_add_item',
    scopePath: ['cart'],
    route: '/cart',
    description: 'Add an item.',
    safety: 'mutate',
    lifetime: 'view',
    inputSchema: null,
    binding: {
      kind: 'handler',
      file: 'src/Cart.js',
      line: 10,
      column: 2,
      component: 'Cart',
      handler: 'addItem',
      params: [],
      paramStyle: 'none',
    },
    evidence: [
      {check: 'binding', level: 'ok', summary: 'binding addItem exists'},
      {check: 'replay', level: 'pending', summary: 'not traced yet'},
      {check: 'trace', level: 'pending', summary: 'no journey recorded'},
    ],
    status: 'proposed',
    inferredAt: '2026-11-01T00:00:00.000Z',
    provider: null,
    ...overrides,
  };
}

function file(proposals) {
  return {
    version: 1,
    generatedAt: '2026-11-01T00:00:00.000Z',
    source: {dir: 'src', files: ['Cart.js']},
    proposals,
  };
}

function evidenceByCheck(traced, index) {
  const map = {};
  traced.proposals[index].evidence.forEach(item => {
    map[item.check] = item;
  });
  return map;
}

describe('infer trace', () => {
  it('parses its arguments', () => {
    const options = parseTraceArgs([
      '--in',
      'tools.proposals.json',
      '--url',
      'http://127.0.0.1:8080/',
    ]);
    expect(options.in.endsWith('tools.proposals.json')).toBe(true);
    expect(options.url).toBe('http://127.0.0.1:8080/');
    expect(options.out).toBe(null);
    expect(parseTraceArgs(['--help']).help).toBe(true);
    expect(() => parseTraceArgs(['--nope'])).toThrow('Unknown argument');
  });

  it('records whether the owning component is mounted', () => {
    const traced = applyTrace(
      file([
        proposal(),
        proposal({
          id: 'other',
          binding: {
            kind: 'handler',
            file: 'src/Other.js',
            line: 1,
            column: 0,
            component: 'Elsewhere',
            handler: 'go',
            params: [],
            paramStyle: 'none',
          },
        }),
        proposal({
          id: 'anon',
          binding: {
            kind: 'handler',
            file: 'src/Cart.js',
            line: 1,
            column: 0,
            component: null,
            handler: null,
            params: [],
            paramStyle: 'none',
          },
        }),
      ]),
      new Set(['App', 'Cart']),
      [],
      {},
      'http://127.0.0.1:1234/',
    );
    expect(evidenceByCheck(traced, 0).mounted).toEqual({
      check: 'mounted',
      level: 'ok',
      summary: 'owner Cart mounted on http://127.0.0.1:1234/',
    });
    expect(evidenceByCheck(traced, 1).mounted.level).toBe('warn');
    expect(evidenceByCheck(traced, 2).mounted.level).toBe('pending');
    // Other evidence survives, and nothing is duplicated.
    expect(traced.proposals[0].evidence.map(item => item.check)).toEqual([
      'binding',
      'trace',
      'mounted',
      'replay',
    ]);
  });

  it('replays only registered read-only tools without required input', () => {
    const traced = applyTrace(
      file([
        proposal({
          id: 'list',
          name: 'list_items',
          qualifiedName: 'cart_list_items',
          safety: 'read',
          status: 'exported',
        }),
        proposal({
          id: 'search',
          name: 'search',
          qualifiedName: 'cart_search',
          safety: 'read',
          status: 'exported',
          inputSchema: {
            type: 'object',
            properties: {query: {type: 'string', description: ''}},
            required: ['query'],
          },
        }),
        proposal({
          id: 'clear',
          name: 'clear',
          qualifiedName: 'cart_clear',
          safety: 'irreversible',
          status: 'exported',
        }),
        proposal({
          id: 'broken',
          name: 'broken',
          qualifiedName: 'cart_broken',
          safety: 'read',
          status: 'exported',
        }),
        proposal(),
      ]),
      new Set(['Cart']),
      ['cart_list_items', 'cart_search', 'cart_clear', 'cart_broken'],
      {
        cart_list_items: {ok: true, length: 42, preview: '1. Green tea'},
        cart_broken: {ok: false, error: 'boom'},
      },
      'http://127.0.0.1:1234/',
    );
    expect(evidenceByCheck(traced, 0).replay).toEqual({
      check: 'replay',
      level: 'ok',
      summary: 'executeTool returned 42 chars: "1. Green tea"',
    });
    expect(evidenceByCheck(traced, 1).replay.summary).toBe(
      'not replayed: requires input',
    );
    expect(evidenceByCheck(traced, 2).replay.summary).toBe(
      'not replayed: irreversible tool',
    );
    expect(evidenceByCheck(traced, 3).replay).toEqual({
      check: 'replay',
      level: 'bad',
      summary: 'executeTool threw: boom',
    });
    expect(evidenceByCheck(traced, 4).replay.summary).toBe(
      'replay runs once the tool exists',
    );
  });
});
