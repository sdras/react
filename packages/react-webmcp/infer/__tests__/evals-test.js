/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails react-core
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {evalFor, planEvals, writeEvals} = require('../evals.flow');

function proposal(overrides) {
  return {
    id: 'Cart.js#Cart.addItem',
    name: 'add_item',
    qualifiedName: 'cart_add_item',
    scopePath: ['cart'],
    route: '/cart',
    description: 'Add an inventory item to the cart by SKU.',
    safety: 'mutate',
    lifetime: 'view',
    inputSchema: {
      type: 'object',
      properties: {
        sku: {type: 'string', description: 'SKU of the item.'},
        quantity: {type: 'number', description: 'How many to add.'},
        gift: {type: 'boolean', description: ''},
      },
      required: ['sku'],
    },
    binding: {
      kind: 'handler',
      file: 'Cart.js',
      line: 3,
      column: 2,
      component: 'Cart',
      handler: 'addItem',
      params: ['sku', 'quantity'],
      paramStyle: 'positional',
    },
    evidence: [],
    status: 'accepted',
    inferredAt: '2026-11-01T00:00:00.000Z',
    provider: null,
    ...overrides,
  };
}

describe('infer emit --evals', () => {
  it('builds an evals-cli eval with placeholder arguments', () => {
    expect(evalFor(proposal())).toEqual({
      messages: [
        {
          role: 'user',
          content:
            'Add an inventory item to the cart by SKU. Use sku <sku> and quantity 1 and gift true.',
        },
      ],
      expectedCall: [
        {
          functionName: 'cart_add_item',
          arguments: {sku: '<sku>', quantity: 1, gift: true},
        },
      ],
    });
    expect(
      evalFor(
        proposal({
          qualifiedName: 'cart_clear',
          inputSchema: null,
          description: 'Clear the cart.',
        }),
      ),
    ).toEqual({
      messages: [{role: 'user', content: 'Clear the cart.'}],
      expectedCall: [{functionName: 'cart_clear', arguments: {}}],
    });
  });

  it('plans one file per tool plus a README, sorted and deduplicated', () => {
    const files = planEvals([
      proposal({qualifiedName: 'todos_add_todo'}),
      proposal(),
      proposal(),
    ]);
    expect(files.map(file => file.file)).toEqual([
      'cart_add_item.eval.json',
      'todos_add_todo.eval.json',
      'README.md',
    ]);
    expect(JSON.parse(files[0].contents).expectedCall[0].functionName).toBe(
      'cart_add_item',
    );
    expect(planEvals([])).toEqual([]);
  });

  it('writes files and keeps hand-edited ones unless forced', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'react-webmcp-evals-'));
    try {
      const files = planEvals([proposal()]);
      expect(writeEvals(dir, files)).toEqual({
        written: ['cart_add_item.eval.json', 'README.md'],
        kept: [],
      });
      fs.writeFileSync(
        path.join(dir, 'cart_add_item.eval.json'),
        '{"edited": true}',
      );
      expect(writeEvals(dir, files)).toEqual({
        written: [],
        kept: ['cart_add_item.eval.json', 'README.md'],
      });
      expect(
        fs.readFileSync(path.join(dir, 'cart_add_item.eval.json'), 'utf8'),
      ).toBe('{"edited": true}');
      expect(writeEvals(dir, files, {force: true}).written).toEqual([
        'cart_add_item.eval.json',
        'README.md',
      ]);
      expect(
        JSON.parse(
          fs.readFileSync(path.join(dir, 'cart_add_item.eval.json'), 'utf8'),
        ).messages,
      ).toHaveLength(1);
    } finally {
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });
});
