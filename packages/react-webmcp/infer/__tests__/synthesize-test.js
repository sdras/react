/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails react-core
 */

'use strict';

const {extractFromSource} = require('react-webmcp/infer/extract.flow');
const {
  getProvider,
  resolveProviderName,
  synthesizeProposals,
} = require('react-webmcp/infer/synthesize.flow');

const NOW = '2026-11-01T00:00:00.000Z';

const INVENTORY = `
import * as React from 'react';
import {useWebMCPTool} from 'react-webmcp';
const {useState} = React;

function CartTools({cart}) {
  useWebMCPTool({
    name: 'list_items',
    description: 'List the items in the cart.',
    safety: 'read',
    execute: () => Object.keys(cart).join(', '),
  });
  return null;
}

function Inventory() {
  const [items, setItems] = useState([]);
  const [resource, setResource] = useState(0);
  const addItem = (sku, quantity) =>
    setItems(current => current.concat({sku, quantity}));
  const clearCart = () => setItems([]);
  return (
    <div>
      <CartTools cart={items} />
      <button type="button" onClick={() => addItem('TEA-001', 1)}>
        Add
      </button>
      <button type="button" onClick={clearCart}>
        Clear
      </button>
      <button type="button" onClick={() => setResource(resource + 1)}>
        Reload inventory
      </button>
    </div>
  );
}
`;

function proposalsFile() {
  return {
    version: 1,
    generatedAt: NOW,
    source: {dir: 'src', files: ['Inventory.js']},
    proposals: extractFromSource(INVENTORY, {file: 'Inventory.js', now: NOW}),
  };
}

describe('infer synthesize', () => {
  it('describes proposed tools deterministically with the fixture provider', async () => {
    const provider = getProvider('fixture');
    expect(provider.name).toBe('fixture');
    const first = await synthesizeProposals(proposalsFile(), provider, {
      now: NOW,
    });
    const second = await synthesizeProposals(proposalsFile(), provider, {
      now: NOW,
    });
    expect(JSON.stringify(second.file)).toBe(JSON.stringify(first.file));

    const byName = new Map(first.file.proposals.map(p => [p.name, p]));
    expect(byName.get('add_item').description).toBe(
      'Add an item (sku, quantity) in Inventory.',
    );
    expect(byName.get('add_item').provider).toBe('fixture');
    expect(byName.get('clear_cart').description).toBe(
      'Clear the cart in Inventory. This cannot be undone.',
    );
    expect(first.touched.map(p => p.name)).toEqual([
      'add_item',
      'clear_cart',
      'reload_inventory',
    ]);
  });

  it('proposes a better name for anonymous handlers and requalifies it', async () => {
    const result = await synthesizeProposals(
      proposalsFile(),
      getProvider('fixture'),
      {now: NOW},
    );
    const reload = result.file.proposals.find(
      p => p.id === 'Inventory.js#Inventory.L31',
    );
    expect(reload.name).toBe('reload_inventory');
    expect(reload.qualifiedName).toBe('reload_inventory');
    expect(reload.description).toBe('Reload the inventory in Inventory.');
  });

  it('leaves exported proposals alone', async () => {
    const input = proposalsFile();
    const before = input.proposals.find(p => p.status === 'exported');
    const result = await synthesizeProposals(input, getProvider('fixture'), {
      now: NOW,
    });
    const after = result.file.proposals.find(p => p.status === 'exported');
    expect(after).toEqual(before);
    expect(after.provider).toBe(null);
    expect(after.description).toBe('List the items in the cart.');
  });

  it('passes the source context to the provider', async () => {
    const seen = [];
    const provider = {
      name: 'recording',
      synthesize(proposals, context) {
        seen.push([proposals.map(p => p.id), context]);
        return Promise.resolve(
          proposals.map(p => ({...p, description: `Rewritten ${p.name}.`})),
        );
      },
    };
    const result = await synthesizeProposals(proposalsFile(), provider, {
      now: NOW,
    });
    expect(seen).toEqual([
      [
        [
          'Inventory.js#Inventory.addItem',
          'Inventory.js#Inventory.clearCart',
          'Inventory.js#Inventory.L31',
        ],
        {source: {dir: 'src', files: ['Inventory.js']}, now: NOW},
      ],
    ]);
    expect(result.touched.map(p => [p.description, p.provider])).toEqual([
      ['Rewritten add_item.', 'recording'],
      ['Rewritten clear_cart.', 'recording'],
      ['Rewritten click_reload_inventory.', 'recording'],
    ]);
  });

  it('knows the network providers and rejects unknown names', () => {
    expect(getProvider('anthropic').name).toBe('anthropic:claude-opus-5-5');
    expect(getProvider('gemini').name).toBe('gemini:gemini-2.5-flash');
    expect(getProvider('openai', {model: 'm'}).name).toBe('openai:m');
    expect(() => getProvider('nope')).toThrow('unknown provider "nope"');
  });

  it('selects the provider from the flag, then the environment', () => {
    expect(resolveProviderName(null, {})).toBe('fixture');
    expect(resolveProviderName(null, {REACT_WEBMCP_LLM: 'gemini'})).toBe(
      'gemini',
    );
    expect(resolveProviderName('fixture', {REACT_WEBMCP_LLM: 'gemini'})).toBe(
      'fixture',
    );
  });
});
