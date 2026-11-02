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
const path = require('path');

const {extractFromSource} = require('react-webmcp/infer/extract.flow');

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

const CHECKOUT = `
import * as React from 'react';

function Checkout({onCheckout}) {
  const handleSubmit = event => {
    event.preventDefault();
    onCheckout();
  };
  return (
    <section>
      <h2>Checkout (step 2)</h2>
      <form onSubmit={handleSubmit}>
        <input name="email" required placeholder="Email" />
        <input name="qty" type="number" />
        <button type="submit">Place order</button>
      </form>
    </section>
  );
}
`;

const TODOS = `
import * as React from 'react';
import {useWebMCPTool, ToolScope} from 'react-webmcp';
const {useState} = React;

function TodoTools({addTodo}) {
  useWebMCPTool({
    name: 'add_todo',
    description: 'Add a new item to the todo list.',
    safety: 'mutate',
    inputSchema: {
      type: 'object',
      properties: {text: {type: 'string', description: 'The text.'}},
      required: ['text'],
    },
    execute: ({text}) => addTodo(text),
  });
  return null;
}

function Todos() {
  const [todos, setTodos] = useState([]);
  const addTodo = text => setTodos(current => current.concat(text));
  return (
    <ToolScope name="todos">
      <TodoTools addTodo={addTodo} />
    </ToolScope>
  );
}
`;

const DRAFT = `
import * as React from 'react';
const {useState} = React;

function Composer() {
  const [draft, setDraft] = useState('');
  return (
    <div>
      <input value={draft} onChange={e => setDraft(e.target.value)} />
      <label>
        <input
          type="checkbox"
          onChange={event => setDraft(event.target.checked ? 'x' : '')}
        />
      </label>
    </div>
  );
}
`;

const PROP_CALLEE = `
import * as React from 'react';

function Row({item, addItem}) {
  return (
    <button type="button" onClick={() => addItem(item.sku, 1)}>
      Add
    </button>
  );
}
`;

const PROP_CALLEE_RESOLVED = `
import * as React from 'react';
const {useState} = React;

function Row({item, addItem}) {
  return (
    <button type="button" onClick={() => addItem(item.sku, 1)}>
      Add
    </button>
  );
}

function Cart() {
  const [cart, setCart] = useState({});
  const addItem = (sku, quantity) => setCart({...cart, [sku]: quantity});
  return <Row item={{sku: 'A'}} addItem={addItem} />;
}
`;

const SCHEMA_DRIFT = `
import {useWebMCPTool} from 'react-webmcp';

function Tools({save}) {
  useWebMCPTool({
    name: 'save_note',
    description: 'Save.',
    inputSchema: {
      type: 'object',
      properties: {
        text: {type: 'string', description: ''},
        extra: {type: 'string', description: ''},
      },
      required: ['text'],
    },
    execute: ({text}) => save(text),
  });
  return null;
}
`;

function extract(source, file = 'App.js', options = {}) {
  return extractFromSource(source, {file, now: NOW, ...options});
}

describe('infer extract', () => {
  it('proposes a tool for a handler that sets state', () => {
    const proposals = extract(INVENTORY);
    expect(proposals.map(p => p.name)).toEqual(['add_item', 'clear_cart']);

    const addItem = proposals[0];
    expect(addItem.id).toBe('App.js#Inventory.addItem');
    expect(addItem.status).toBe('proposed');
    expect(addItem.safety).toBe('mutate');
    expect(addItem.lifetime).toBe('view');
    expect(addItem.provider).toBe(null);
    expect(addItem.inferredAt).toBe(NOW);
    expect(addItem.qualifiedName).toBe('add_item');
    expect(addItem.scopePath).toEqual([]);
    expect(addItem.description).toBe('Add item. Takes sku, quantity.');
    expect(addItem.binding).toEqual({
      kind: 'handler',
      file: 'App.js',
      line: 7,
      column: 19,
      component: 'Inventory',
      handler: 'addItem',
      params: ['sku', 'quantity'],
      paramStyle: 'positional',
    });
    expect(addItem.inputSchema).toEqual({
      type: 'object',
      properties: {
        sku: {type: 'string', description: ''},
        quantity: {type: 'number', description: ''},
      },
      required: ['sku', 'quantity'],
    });
    expect(addItem.evidence.map(row => [row.check, row.level])).toEqual([
      ['binding', 'ok'],
      ['schema', 'ok'],
      ['replay', 'pending'],
      ['trace', 'pending'],
    ]);
    expect(addItem.evidence[0]).toEqual({
      check: 'binding',
      level: 'ok',
      summary: 'binding addItem exists',
      location: {file: 'App.js', line: 7, column: 19},
    });
  });

  it('marks a clearing handler without parameters as irreversible', () => {
    const clearCart = extract(INVENTORY)[1];
    expect(clearCart.name).toBe('clear_cart');
    expect(clearCart.safety).toBe('irreversible');
    expect(clearCart.inputSchema).toBe(null);
    expect(clearCart.binding.params).toEqual([]);
    expect(clearCart.binding.paramStyle).toBe('none');
    expect(clearCart.description).toBe('Clear cart.');
  });

  it('turns a form with named inputs into one proposal', () => {
    const proposals = extract(CHECKOUT);
    expect(proposals.map(p => p.name)).toEqual(['submit_checkout']);
    const form = proposals[0];
    expect(form.id).toBe('App.js#Checkout.handleSubmit');
    expect(form.safety).toBe('irreversible');
    expect(form.binding).toEqual({
      kind: 'form',
      file: 'App.js',
      line: 12,
      column: 7,
      component: 'Checkout',
      handler: 'handleSubmit',
      params: ['email', 'qty'],
      paramStyle: 'object',
    });
    expect(form.inputSchema).toEqual({
      type: 'object',
      properties: {
        email: {type: 'string', description: 'Email'},
        qty: {type: 'number', description: ''},
      },
      required: ['email'],
    });
  });

  it('reports existing tools as exported with their static scope path', () => {
    const proposals = extract(TODOS);
    expect(proposals.map(p => [p.name, p.status, p.qualifiedName])).toEqual([
      ['add_todo', 'exported', 'todos_add_todo'],
      ['add_todo', 'proposed', 'add_todo'],
    ]);
    const existing = proposals[0];
    expect(existing.id).toBe('App.js#TodoTools.add_todo');
    expect(existing.scopePath).toEqual(['todos']);
    expect(existing.description).toBe('Add a new item to the todo list.');
    expect(existing.safety).toBe('mutate');
    expect(existing.inputSchema).toEqual({
      type: 'object',
      properties: {text: {type: 'string', description: 'The text.'}},
      required: ['text'],
    });
    expect(existing.binding).toEqual({
      kind: 'existing-hook',
      file: 'App.js',
      line: 7,
      column: 3,
      component: 'TodoTools',
      handler: null,
      params: ['text'],
      paramStyle: 'object',
    });
    expect(
      existing.evidence.map(row => [row.check, row.level, row.summary]),
    ).toEqual([
      ['binding', 'ok', 'already implemented at App.js:7'],
      ['schema', 'ok', 'schema matches handler parameters'],
      ['replay', 'pending', 'not traced yet'],
      ['trace', 'pending', 'no journey recorded'],
    ]);
    expect(proposals[1].id).toBe('App.js#Todos.addTodo');
  });

  it('warns about schema properties the execute function never reads', () => {
    const [tool] = extract(SCHEMA_DRIFT);
    expect(tool.status).toBe('exported');
    expect(tool.evidence[1]).toEqual({
      check: 'schema',
      level: 'warn',
      property: 'extra',
      summary: 'extra is never read',
    });
  });

  it('ignores text field plumbing', () => {
    expect(extract(DRAFT)).toEqual([]);
  });

  it('attributes a forwarded prop call to the prop callee', () => {
    const [proposal] = extract(PROP_CALLEE);
    expect(proposal.name).toBe('add_item');
    expect(proposal.binding.handler).toBe('addItem');
    expect(proposal.binding.component).toBe('Row');
    expect(proposal.binding.params).toEqual(['arg1', 'arg2']);
    expect(proposal.evidence[0]).toEqual({
      check: 'binding',
      level: 'warn',
      summary: 'addItem comes from props; defined elsewhere',
      location: {file: 'App.js', line: 6, column: 36},
    });
  });

  it('keeps the named handler when an inline one forwards to it', () => {
    const proposals = extract(PROP_CALLEE_RESOLVED);
    expect(proposals.map(p => [p.name, p.binding.component])).toEqual([
      ['add_item', 'Cart'],
    ]);
    expect(proposals[0].binding.params).toEqual(['sku', 'quantity']);
  });

  it('is deterministic across runs', () => {
    const first = extract(INVENTORY);
    const second = extract(INVENTORY);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.map(p => p.id)).toEqual([
      'App.js#Inventory.addItem',
      'App.js#Inventory.clearCart',
    ]);
  });

  it('derives routes from the path, the scope, or the component', () => {
    expect(extract(INVENTORY, 'src/pages/cart/index.js')[0].route).toBe(
      '/cart',
    );
    expect(extract(INVENTORY, 'src/app/checkout/page.tsx')[0].route).toBe(
      '/checkout',
    );
    expect(extract(INVENTORY, 'App.js')[0].route).toBe('/inventory');
    expect(
      extract(TODOS, 'App.js', {routeFrom: 'scope'}).map(p => p.route),
    ).toEqual(['/todos', '/']);
    expect(
      extract(TODOS, 'App.js', {routeFrom: 'component'}).map(p => p.route),
    ).toEqual(['/todo-tools', '/todos']);
  });

  it('finds the fixture tools and handlers', () => {
    const file = path.resolve(
      __dirname,
      '../../../../fixtures/webmcp/src/App.js',
    );
    const proposals = extract(fs.readFileSync(file, 'utf8'), 'App.js');
    const exported = proposals
      .filter(p => p.status === 'exported')
      .map(p => p.qualifiedName);
    expect(exported).toEqual(
      expect.arrayContaining([
        'todos_add_todo',
        'todos_list_todos',
        'todos_clear_todos',
        'todos_search_search_todos',
        'cart_add_item',
        'cart_list_items',
        'cart_clear',
      ]),
    );
    const proposed = proposals
      .filter(p => p.status === 'proposed')
      .map(p => p.name);
    expect(proposed).toEqual(
      expect.arrayContaining([
        'add_todo',
        'clear_todos',
        'submit_todos',
        'add_item',
        'clear_cart',
        'click_reload_inventory',
      ]),
    );
    // The inline "Add" button in Inventory forwards to Cart's addItem.
    expect(
      proposals.filter(
        p =>
          p.status === 'proposed' &&
          p.name === 'add_item' &&
          p.binding.component === 'Inventory',
      ),
    ).toEqual([]);
  });
});

describe('infer extract tuning', () => {
  const NOW_ = '2026-11-01T00:00:00.000Z';
  function run(source, file = 'App.js') {
    return extractFromSource(source, {file, now: NOW_});
  }

  it('flags handlers that only flip UI state instead of dropping them', () => {
    const proposals = run(`
import * as React from 'react';
const {useState} = React;
function Panel() {
  const [open, setOpen] = useState(false);
  const [suspended, setSuspended] = useState(false);
  const [count, setCount] = useState(0);
  const toggleSuspended = () => setSuspended(value => !value);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>Review agent tools</button>
      <button type="button" onClick={toggleSuspended}>Suspend</button>
      <button type="button" onClick={() => setCount(count + 1)}>Count</button>
    </div>
  );
}
`);
    const byName = {};
    proposals.forEach(proposal => {
      byName[proposal.name] = proposal;
    });
    expect(Object.keys(byName).sort()).toEqual([
      'click_count',
      'click_review_agent_tools',
      'toggle_suspended',
    ]);
    const intent = proposal =>
      proposal.evidence
        .filter(row => row.check === 'intent')
        .map(row => row.summary);
    expect(intent(byName.click_review_agent_tools)).toEqual([
      'only toggles setOpen; looks like UI state, not an action an agent needs',
    ]);
    expect(intent(byName.toggle_suspended)).toEqual([
      'only toggles setSuspended; looks like UI state, not an action an agent needs',
    ]);
    expect(intent(byName.click_count)).toEqual([]);
  });

  it('names form inputs without a name after what the page shows, and says so', () => {
    const proposals = run(`
import * as React from 'react';
function Todos({add}) {
  const [draft, setDraft] = React.useState('');
  return (
    <section>
      <h2>Todos</h2>
      <form onSubmit={event => { event.preventDefault(); add(draft); }}>
        <input value={draft} onChange={e => setDraft(e.target.value)} placeholder="Something to do" />
        <label htmlFor="qty">Quantity</label>
        <input id="qty" type="number" />
        <input aria-label="Note" />
        <button type="submit">Add</button>
      </form>
    </section>
  );
}
`);
    const form = proposals.find(proposal => proposal.binding.kind === 'form');
    expect(form.name).toBe('submit_todos');
    expect(form.safety).toBe('mutate');
    expect(Object.keys(form.inputSchema.properties)).toEqual([
      'something_to_do',
      'qty',
      'note',
    ]);
    expect(form.inputSchema.properties.qty.type).toBe('number');
    expect(form.inputSchema.properties.qty.description).toBe('Quantity');
    expect(
      form.evidence
        .filter(row => row.check === 'schema')
        .map(row => [row.level, row.property, row.summary]),
    ).toEqual([
      [
        'warn',
        'something_to_do',
        '"something_to_do" is named after the input\'s placeholder; give the input a name',
      ],
      [
        'warn',
        'qty',
        '"qty" is named after the input\'s id; give the input a name',
      ],
      [
        'warn',
        'note',
        '"note" is named after the input\'s aria-label; give the input a name',
      ],
    ]);
  });

  it('treats submission as a mutation unless the object is consequential', () => {
    const source = name => `
import * as React from 'react';
function Page({send}) {
  return <form aria-label="${name}" onSubmit={e => { e.preventDefault(); send(); }}><input name="email" /></form>;
}
`;
    expect(run(source('newsletter'))[0].safety).toBe('mutate');
    expect(run(source('order'))[0].safety).toBe('irreversible');
    expect(run(source('payment details'))[0].safety).toBe('irreversible');
  });
});
