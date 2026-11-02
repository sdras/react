/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

'use strict';

// Builds a ToolProposal with sensible defaults for tests of the review
// overlay; pass overrides for the fields a test cares about.
function createProposal(overrides = {}) {
  const name = overrides.name || 'add_item';
  const scopePath = overrides.scopePath || ['cart'];
  const handler =
    overrides.handler === undefined ? 'addItem' : overrides.handler;
  const file = overrides.file || 'src/Cart.js';
  const component =
    overrides.component === undefined ? 'Cart' : overrides.component;
  const proposal = {
    id:
      overrides.id || file + '#' + (component || '-') + '.' + (handler || 'L1'),
    name,
    qualifiedName: scopePath.concat(name).join('_'),
    scopePath,
    route: overrides.route || '/cart',
    description: overrides.description || 'Add an inventory item to the cart.',
    safety: overrides.safety || 'mutate',
    lifetime: overrides.lifetime || 'view',
    inputSchema:
      overrides.inputSchema !== undefined
        ? overrides.inputSchema
        : {
            type: 'object',
            properties: {
              sku: {type: 'string', description: 'SKU of the item.'},
              quantity: {type: 'number', description: 'How many to add.'},
            },
            required: ['sku'],
          },
    binding: {
      kind: overrides.kind || 'handler',
      file,
      line: overrides.line || 42,
      column: 2,
      component,
      handler,
      params: overrides.params || ['sku', 'quantity'],
      paramStyle: overrides.paramStyle || 'positional',
    },
    evidence: overrides.evidence || [
      {
        check: 'binding',
        level: 'ok',
        summary: 'binding addItem exists',
        location: {file, line: overrides.line || 42, column: 2},
      },
      {
        check: 'schema',
        level: 'ok',
        summary: 'schema matches handler parameters',
      },
      {check: 'replay', level: 'pending', summary: 'not traced yet'},
    ],
    status: overrides.status || 'proposed',
    inferredAt: overrides.inferredAt || '2026-11-01T12:00:00.000Z',
    provider: overrides.provider === undefined ? null : overrides.provider,
  };
  return proposal;
}

module.exports = {createProposal};
