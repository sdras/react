/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails react-core
 */

'use strict';

const parser = require('@babel/parser');

const {extractFromSource} = require('react-webmcp/infer/extract.flow');
const {
  planEmitForSource,
  unifiedDiff,
} = require('react-webmcp/infer/emit.flow');

const NOW = '2026-11-01T00:00:00.000Z';

const INVENTORY = `
import * as React from 'react';
const {useState} = React;

function Inventory() {
  const [items, setItems] = useState([]);
  const addItem = (sku, quantity) =>
    setItems(current => current.concat({sku, quantity}));
  const clearCart = () => setItems([]);
  return (
    <div>
      <button type="button" onClick={() => addItem('TEA-001', 1)}>
        Add
      </button>
      <button type="button" onClick={clearCart}>
        Clear
      </button>
    </div>
  );
}
`;

const PROFILE = `
import {ToolScope} from 'react-webmcp';
import {useState} from 'react';

export const Profile = () => {
  const [profile, setProfile] = useState({});
  const saveProfile = ({name, email}) => setProfile({name, email});
  return (
    <ToolScope name="profile">
      <button type="button" onClick={() => saveProfile({name: 'a', email: 'b'})}>
        Save
      </button>
    </ToolScope>
  );
};
`;

const CHECKOUT = `
import * as React from 'react';

function Checkout({onCheckout}) {
  const handleSubmit = event => {
    event.preventDefault();
    onCheckout();
  };
  return (
    <section>
      <h2>Checkout</h2>
      <form onSubmit={handleSubmit}>
        <input name="email" required placeholder="Email" />
        <input name="qty" type="number" />
        <button type="submit">Place order</button>
      </form>
    </section>
  );
}
`;

function accepted(source, file) {
  return extractFromSource(source, {file, now: NOW}).map(proposal => ({
    ...proposal,
    status: 'accepted',
  }));
}

function parses(source) {
  parser.parse(source, {sourceType: 'module', plugins: ['jsx', 'flow']});
}

describe('infer emit', () => {
  it('inserts the import and a marked hook block at the top of the component', () => {
    const file = 'src/Inventory.js';
    const plan = planEmitForSource(INVENTORY, accepted(INVENTORY, file), {
      file,
    });
    expect(plan.error).toBe(null);
    expect(plan.skipped).toEqual([]);
    expect(plan.inserted.map(entry => entry.name)).toEqual([
      'add_item',
      'clear_cart',
    ]);
    expect(plan.after).toContain(
      "import * as React from 'react';\n" +
        "import {useWebMCPTool} from 'react-webmcp';\n" +
        'const {useState} = React;\n',
    );
    expect(plan.after).toContain(
      [
        'function Inventory() {',
        '  // react-webmcp: proposed by `yarn infer-tools` (id src/Inventory.js#Inventory.addItem). Review before shipping.',
        '  useWebMCPTool({',
        "    name: 'add_item',",
        "    description: 'Add item. Takes sku, quantity.',",
        "    safety: 'mutate',",
        '    inputSchema: {',
        "      type: 'object',",
        '      properties: {',
        "        sku: {type: 'string', description: ''},",
        "        quantity: {type: 'number', description: ''},",
        '      },',
        "      required: ['sku', 'quantity'],",
        '    },',
        '    execute: ({sku, quantity}) => addItem(sku, quantity),',
        '  });',
        '',
        '  // react-webmcp: proposed by `yarn infer-tools` (id src/Inventory.js#Inventory.clearCart). Review before shipping.',
        '  useWebMCPTool({',
        "    name: 'clear_cart',",
        "    description: 'Clear cart.',",
        "    safety: 'irreversible',",
        '    execute: () => clearCart(),',
        '  });',
        '',
        '  const [items, setItems] = useState([]);',
      ].join('\n'),
    );
    expect(() => parses(plan.after)).not.toThrow();
  });

  it('is idempotent and reports what it skipped', () => {
    const file = 'src/Inventory.js';
    const proposals = accepted(INVENTORY, file);
    const first = planEmitForSource(INVENTORY, proposals, {file});
    const second = planEmitForSource(first.after, proposals, {file});
    expect(second.after).toBe(first.after);
    expect(second.inserted).toEqual([]);
    expect(second.skipped).toEqual([
      {
        id: 'src/Inventory.js#Inventory.addItem',
        name: 'add_item',
        reason: 'already defined in src/Inventory.js',
      },
      {
        id: 'src/Inventory.js#Inventory.clearCart',
        name: 'clear_cart',
        reason: 'already defined in src/Inventory.js',
      },
    ]);
  });

  it('extends an existing react-webmcp import and handles object params', () => {
    const file = 'src/Profile.js';
    const plan = planEmitForSource(PROFILE, accepted(PROFILE, file), {file});
    expect(plan.error).toBe(null);
    expect(plan.inserted.map(entry => entry.name)).toEqual(['save_profile']);
    expect(plan.after).toContain(
      "import {ToolScope, useWebMCPTool} from 'react-webmcp';",
    );
    expect(plan.after).toContain(
      'export const Profile = () => {\n' +
        '  // react-webmcp: proposed by `yarn infer-tools` (id src/Profile.js#Profile.saveProfile). Review before shipping.\n' +
        '  useWebMCPTool({\n',
    );
    expect(plan.after).toContain('    execute: input => saveProfile(input),\n');
    expect(() => parses(plan.after)).not.toThrow();
  });

  it('leaves a TODO body for forms', () => {
    const file = 'src/Checkout.js';
    const plan = planEmitForSource(CHECKOUT, accepted(CHECKOUT, file), {file});
    expect(plan.error).toBe(null);
    expect(plan.inserted.map(entry => entry.name)).toEqual(['submit_checkout']);
    expect(plan.after).toContain(
      '  // TODO: forms need your judgment; wire execute to handleSubmit.\n',
    );
    expect(plan.after).toContain(
      '    execute: input => {\n' +
        '      /* TODO: submit handleSubmit with input */\n' +
        '    },\n',
    );
    expect(() => parses(plan.after)).not.toThrow();
  });

  it('does nothing for existing tools or unknown components', () => {
    const file = 'src/Inventory.js';
    const proposals = accepted(INVENTORY, file);
    const existing = {
      ...proposals[0],
      binding: {...proposals[0].binding, kind: 'existing-hook'},
    };
    const orphan = {
      ...proposals[1],
      binding: {...proposals[1].binding, component: 'Nope'},
    };
    const plan = planEmitForSource(INVENTORY, [existing, orphan], {file});
    expect(plan.after).toBe(INVENTORY);
    expect(plan.inserted).toEqual([]);
    expect(plan.skipped.map(entry => entry.reason)).toEqual([
      'already implemented in source',
      'component Nope was not found in src/Inventory.js',
    ]);
  });

  it('prints a unified diff for the dry run', () => {
    const file = 'src/Inventory.js';
    const plan = planEmitForSource(INVENTORY, accepted(INVENTORY, file), {
      file,
    });
    const diff = unifiedDiff(file, plan.before, plan.after);
    expect(diff).toContain('--- a/src/Inventory.js\n+++ b/src/Inventory.js\n');
    expect(diff).toContain("+import {useWebMCPTool} from 'react-webmcp';\n");
    expect(diff).toContain('+  useWebMCPTool({\n');
    expect(diff).toContain(' function Inventory() {\n');
    expect(diff).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/);
    expect(unifiedDiff(file, INVENTORY, INVENTORY)).toBe('');
  });
});
