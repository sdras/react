/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails react-core
 */

'use strict';

const {
  applyJourneys,
  applyTrace,
  parseTraceArgs,
  stepMatch,
} = require('../trace.flow');

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
      'not replayed: requires input (add a journey step to run it)',
    );
    expect(evidenceByCheck(traced, 2).replay.summary).toBe(
      'not replayed: irreversible tool (add a journey step to run it)',
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

  describe('journeys', () => {
    function step(overrides) {
      return {
        index: 1,
        kind: 'click',
        label: 'click "Add"',
        ok: true,
        error: null,
        owners: ['Inventory', 'Cart', 'App'],
        handler: null,
        handlerSource: null,
        changed: true,
        output: null,
        ...overrides,
      };
    }

    it('scores how strongly a step exercised a proposal', () => {
      const named = proposal({
        binding: {...proposal().binding, component: 'Cart', handler: 'addItem'},
      });
      expect(stepMatch(step({handler: 'addItem'}), named)).toBe(2);
      // Touched Cart, but Inventory is the nearest owner: no credit.
      expect(stepMatch(step({handler: 'clearCart'}), named)).toBe(0);
      expect(
        stepMatch(step({handler: 'clearCart', owners: ['Cart', 'App']}), named),
      ).toBe(1);
      // An inline arrow that forwards to the handler counts as running it.
      expect(
        stepMatch(step({handlerSource: '() => addItem(item.sku, 1)'}), named),
      ).toBe(2);
      expect(
        stepMatch(
          step({handlerSource: '() => addItems()', owners: ['Cart']}),
          named,
        ),
      ).toBe(1);
      // Typing credits only the onChange handler itself.
      expect(stepMatch(step({kind: 'fill', owners: ['Cart']}), named)).toBe(0);
      expect(
        stepMatch(
          step({kind: 'fill', owners: ['Cart'], handler: 'addItem'}),
          named,
        ),
      ).toBe(2);
      expect(stepMatch(step({owners: ['Todos']}), named)).toBe(0);
      expect(stepMatch(step({kind: 'tool'}), named)).toBe(0);

      const inline = proposal({
        name: 'click_add',
        binding: {...proposal().binding, component: 'Inventory', handler: null},
      });
      expect(stepMatch(step({handler: null}), inline)).toBe(2);
      expect(
        stepMatch(step({handler: null, label: 'click "Clear"'}), inline),
      ).toBe(1);
      expect(
        stepMatch(
          step({handler: null, label: 'click "Add" near "Tea"'}),
          inline,
        ),
      ).toBe(2);

      const form = proposal({
        name: 'submit_todos',
        binding: {
          ...proposal().binding,
          kind: 'form',
          component: 'Todos',
          handler: null,
        },
      });
      expect(
        stepMatch(step({owners: ['Todos'], handler: 'onSubmit'}), form),
      ).toBe(2);
      expect(stepMatch(step({owners: ['Todos'], handler: null}), form)).toBe(1);
      expect(stepMatch(step({kind: 'fill', owners: ['Todos']}), form)).toBe(0);
    });

    it('writes trace and replay evidence from journey runs', () => {
      const runs = [
        {
          name: 'shop',
          steps: [
            step({index: 1, handler: 'addItem'}),
            step({
              index: 2,
              kind: 'tool',
              label: 'tool cart_list_items',
              owners: [],
              changed: false,
              output: '{"content":[]}',
            }),
            step({index: 3, label: 'click "Clear"', owners: ['Cart', 'App']}),
            step({
              index: 4,
              ok: false,
              error: 'no element',
              owners: [],
              changed: false,
            }),
          ],
        },
      ];
      const traced = applyJourneys(
        file([
          proposal({
            binding: {
              ...proposal().binding,
              component: 'Cart',
              handler: 'addItem',
            },
          }),
          proposal({
            id: 'clear',
            name: 'clear_cart',
            qualifiedName: 'cart_clear_cart',
            binding: {
              ...proposal().binding,
              component: 'Cart',
              handler: 'clearCart',
            },
          }),
          proposal({
            id: 'list',
            name: 'list_items',
            qualifiedName: 'cart_list_items',
            safety: 'read',
            status: 'exported',
          }),
          proposal({
            id: 'todo',
            name: 'add_todo',
            qualifiedName: 'add_todo',
            binding: {
              ...proposal().binding,
              component: 'Todos',
              handler: 'addTodo',
            },
          }),
        ]),
        runs,
      );
      expect(evidenceByCheck(traced, 0).trace).toEqual({
        check: 'trace',
        level: 'ok',
        summary:
          'journey shop step 1: click "Add" ran addItem and the page changed',
      });
      expect(evidenceByCheck(traced, 1).trace).toEqual({
        check: 'trace',
        level: 'warn',
        summary:
          'journey shop step 3: click "Clear" touched Cart, but which handler ran is unclear',
      });
      expect(evidenceByCheck(traced, 2).replay).toEqual({
        check: 'replay',
        level: 'ok',
        summary:
          'journey shop step 2: executeTool returned "{"content":[]}"; nothing visible changed',
      });
      expect(evidenceByCheck(traced, 3).trace).toEqual({
        check: 'trace',
        level: 'pending',
        summary: 'not exercised by shop',
      });
      expect(applyJourneys(file([proposal()]), [])).toEqual(file([proposal()]));
    });
  });
});
