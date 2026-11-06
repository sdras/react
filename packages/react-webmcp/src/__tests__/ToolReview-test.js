/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails react-core
 */

'use strict';

const React = require('react');
const Scheduler = require('scheduler');
const {act} = require('internal-test-utils');
const {createProposal} = require('./utils/createProposal');
const {createFakeModelContext} = require('./utils/createFakeModelContext');

let ToolReview;
let ReactDOM;
let ReactDOMClient;

// The jest host-config setup forks shared/ReactSharedInternals per module
// registry; both renderers must see the same dispatcher slot for hooks. The
// built bundles already share it through the `react` mock below, and the
// build config cannot resolve this source path.
function mockSharedInternals() {
  if (!process.env.IS_BUILD) {
    jest.mock(
      'shared/ReactSharedInternals',
      () =>
        React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE,
    );
  }
}

// Fresh renderers for every test, so each starts with an empty registry. The
// review entry (and with it the tool renderer) loads first so it gets its own
// reconciler instance, together with the react-dom the overlay reads the
// registry from: tools registered through its hook are what the overlay
// lists as exported. The DOM renderer is then isolated in a second module
// registry, sharing the isomorphic modules.
function loadRenderers() {
  jest.resetModules();
  delete globalThis.__REACT_WEBMCP__;
  jest.mock('scheduler', () => Scheduler);
  jest.mock('react', () => React);
  mockSharedInternals();
  ({ToolReview} = require('react-webmcp/unstable_review'));
  ReactDOM = require('react-dom');

  jest.resetModules();
  jest.mock('scheduler', () => Scheduler);
  jest.mock('react', () => React);
  mockSharedInternals();
  ReactDOMClient = require('react-dom/client');
}

let container;
let root;
let storageKey;
let keyCounter = 0;

// Tools registered in the page through react-dom's hook, inside a scope.
function LiveTool({name}) {
  ReactDOM.unstable_useWebMCPTool({
    name,
    description: 'Live ' + name + '.',
    safety: 'read',
    execute: () => name,
  });
  return null;
}

function LiveTools({names}) {
  return (
    <ReactDOM.unstable_WebMCPScope name="cart">
      {names.map(name => (
        <LiveTool key={name} name={name} />
      ))}
    </ReactDOM.unstable_WebMCPScope>
  );
}

function proposals() {
  return [
    createProposal({route: '/cart'}),
    createProposal({
      route: '/cart',
      name: 'clear',
      handler: 'clearCart',
      description: 'Remove every item from the cart.',
      safety: 'irreversible',
      inputSchema: null,
      params: [],
      paramStyle: 'none',
      evidence: [
        {check: 'binding', level: 'ok', summary: 'binding clearCart exists'},
        {
          check: 'schema',
          level: 'warn',
          summary: 'quantity is never read',
          property: 'quantity',
        },
      ],
    }),
    createProposal({
      route: '/checkout',
      scopePath: ['checkout'],
      name: 'place_order',
      handler: 'placeOrder',
      component: 'Checkout',
      file: 'src/Checkout.js',
      description: 'Submit the order.',
      safety: 'irreversible',
    }),
  ];
}

async function render(props, siblings = null) {
  await act(() => {
    root.render(
      <>
        {siblings}
        <ToolReview storageKey={storageKey} {...props} />
      </>,
    );
  });
}

function rows() {
  return Array.from(container.querySelectorAll('.rwr-Row')).map(row => [
    row.getAttribute('data-tool-name'),
    row.getAttribute('data-status'),
    row.classList.contains('rwr-RowOn') ? 'selected' : '',
  ]);
}

function text(selector) {
  const node = container.querySelector(selector);
  return node === null ? null : node.textContent;
}

function buttonWithText(label) {
  return Array.from(container.querySelectorAll('button')).find(
    button => button.textContent.trim().indexOf(label) === 0,
  );
}

async function click(element) {
  await act(() => {
    element.click();
  });
}

async function setValue(element, value) {
  const prototype =
    element.tagName === 'TEXTAREA'
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value').set;
  await act(() => {
    setter.call(element, value);
    element.dispatchEvent(new Event('input', {bubbles: true}));
  });
}

async function press(key, target) {
  await act(() => {
    (target || container.querySelector('[role="dialog"]')).dispatchEvent(
      new KeyboardEvent('keydown', {key, bubbles: true, cancelable: true}),
    );
  });
}

describe('ToolReview', () => {
  beforeEach(() => {
    loadRenderers();
    document.modelContext = createFakeModelContext();
    localStorage.clear();
    storageKey = 'test-' + ++keyCounter;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOMClient.createRoot(container);
  });

  afterEach(async () => {
    await act(() => {
      root.unmount();
    });
    container.remove();
    document.body.style.overflow = '';
    delete document.modelContext;
  });

  it('renders nothing while closed', async () => {
    await render({proposals: proposals(), open: false});
    expect(container.innerHTML).toBe('');
  });

  it('lists proposals grouped by route and reports progress', async () => {
    await render({proposals: proposals()});
    expect(text('.rwr-Subtitle')).toBe(
      '3 candidates found in your handlers, forms and hooks. Nothing ships until you export.',
    );
    expect(text('.rwr-ProgressLabel')).toBe('0 of 3 reviewed0%');
    expect(
      Array.from(container.querySelectorAll('.rwr-GroupName')).map(
        node => node.textContent,
      ),
    ).toEqual(['/cart', '/checkout']);
    expect(rows()).toEqual([
      ['cart_add_item', 'proposed', 'selected'],
      ['cart_clear', 'proposed', ''],
      ['checkout_place_order', 'proposed', ''],
    ]);
    // The warned proposal shows its attention icon; the clean one does not.
    const statusCells = container.querySelectorAll('.rwr-Row .rwr-Status');
    expect(statusCells[0].querySelector('svg')).toBe(null);
    expect(statusCells[1].querySelector('svg')).not.toBe(null);
    expect(text('.rwr-ListFoot span')).toBe('3 tools in 2 routes');
    expect(text('.rwr-FormName')).toBe('cart_add_item');
    expect(text('.rwr-EvidenceHead')).toContain('Grounded · 2 of 2 checks');
    expect(document.body.style.overflow).toBe('hidden');
    expect(document.activeElement).toBe(
      container.querySelector('.rwr-SearchInput'),
    );
  });

  it('accepts the selected tool and moves to the next undecided one', async () => {
    await render({proposals: proposals()});
    await click(buttonWithText('Accept and next'));
    expect(rows()).toEqual([
      ['cart_add_item', 'accepted', ''],
      ['cart_clear', 'proposed', 'selected'],
      ['checkout_place_order', 'proposed', ''],
    ]);
    expect(text('.rwr-ProgressLabel')).toBe('1 of 3 reviewed33%');
    expect(text('.rwr-FootNote')).toBe('1 accepted · 2 still to review');
    // Revisit the accepted one: it offers an undo instead of accept/reject.
    await click(container.querySelector('.rwr-Row'));
    expect(buttonWithText('Undo accepted')).not.toBe(undefined);
    await click(buttonWithText('Undo accepted'));
    expect(rows()[0]).toEqual(['cart_add_item', 'proposed', 'selected']);
  });

  it('reviews from the keyboard and closes on Escape', async () => {
    const onClose = jest.fn();
    await render({proposals: proposals(), onClose});
    const search = container.querySelector('.rwr-SearchInput');
    search.blur();
    expect(document.activeElement).not.toBe(search);
    await press('/');
    expect(document.activeElement).toBe(search);
    search.blur();

    await press('ArrowDown');
    expect(rows()[1][2]).toBe('selected');
    await press('r');
    expect(rows()).toEqual([
      ['cart_add_item', 'proposed', ''],
      ['cart_clear', 'rejected', ''],
      ['checkout_place_order', 'proposed', 'selected'],
    ]);
    await press('a');
    expect(rows()[2]).toEqual(['checkout_place_order', 'accepted', '']);
    // Wraps around to the only remaining undecided tool.
    expect(rows()[0][2]).toBe('selected');

    // Keys typed into a field are left alone.
    await press('r', container.querySelector('.rwr-Input'));
    expect(rows()[0][1]).toBe('proposed');

    expect(onClose).not.toHaveBeenCalled();
    await press('Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('exports accepted tools with their edits and the rejected ids', async () => {
    const onExport = jest.fn();
    const items = proposals();
    await render({proposals: items, onExport});
    expect(buttonWithText('Export 0 accepted').disabled).toBe(true);

    await setValue(
      container.querySelector('.rwr-Textarea'),
      'Add an inventory item to the cart by SKU.',
    );
    // Safety: consequential.
    await click(buttonWithText('consequential'));
    expect(text('.rwr-FormName')).toBe('cart_add_item');
    await click(buttonWithText('Accept and next'));
    await click(buttonWithText('Reject'));
    const exportButton = buttonWithText('Export 1 accepted');
    expect(exportButton.disabled).toBe(false);
    await click(exportButton);
    expect(onExport).toHaveBeenCalledTimes(1);
    const data = onExport.mock.calls[0][0];
    expect(data.version).toBe(1);
    expect(data.rejected).toEqual([items[1].id]);
    expect(data.accepted).toHaveLength(1);
    expect(data.accepted[0]).toMatchObject({
      id: items[0].id,
      description: 'Add an inventory item to the cart by SKU.',
      safety: 'irreversible',
      status: 'accepted',
    });
  });

  it('edits the input schema', async () => {
    const onExport = jest.fn();
    await render({proposals: proposals(), onExport});
    // The warned proposal's schema flag shows on its property row.
    await click(container.querySelectorAll('.rwr-Row')[1]);
    expect(text('.rwr-PropEmpty')).toBe(
      'No parameters. The tool takes no input.',
    );
    await click(buttonWithText('Property'));
    const nameInput = container.querySelector('.rwr-PropName');
    await setValue(nameInput, 'confirm');
    const required = container.querySelector('.rwr-PropReq');
    await click(required);
    await click(buttonWithText('Accept and next'));
    await click(buttonWithText('Export 1 accepted'));
    expect(onExport.mock.calls[0][0].accepted[0].inputSchema).toEqual({
      type: 'object',
      properties: {confirm: {type: 'string', description: ''}},
      required: ['confirm'],
    });
  });

  // @gate enableWebMCP
  it('shows registered tools as exported and follows the registry', async () => {
    await render(
      {proposals: proposals()},
      <LiveTools names={['add_item', 'get_total']} />,
    );
    expect(rows()).toEqual([
      ['cart_add_item', 'exported', ''],
      ['cart_clear', 'proposed', 'selected'],
      ['cart_get_total', 'exported', ''],
      ['checkout_place_order', 'proposed', ''],
    ]);
    expect(text('.rwr-Subtitle')).toContain('2 candidates');
    await click(container.querySelector('.rwr-Row'));
    expect(text('.rwr-Note')).toBe(
      'This tool is registered in the page right now. Edit it in source.',
    );
    expect(buttonWithText('Accept and next')).toBe(undefined);

    // A tool registered later shows up: the overlay follows the registry.
    await render(
      {proposals: proposals()},
      <LiveTools names={['add_item', 'get_total', 'list_items']} />,
    );
    expect(rows().map(row => row[0])).toContain('cart_list_items');
    await render(
      {proposals: proposals()},
      <LiveTools names={['add_item', 'get_total']} />,
    );
    expect(rows().map(row => row[0])).not.toContain('cart_list_items');
  });

  it('remembers decisions across remounts with the same storage key', async () => {
    await render({proposals: proposals()});
    await click(buttonWithText('Accept and next'));
    await act(() => {
      root.unmount();
    });
    root = ReactDOMClient.createRoot(container);
    await render({proposals: proposals()});
    expect(rows()[0]).toEqual(['cart_add_item', 'accepted', '']);
    expect(text('.rwr-ProgressLabel')).toBe('1 of 3 reviewed33%');

    await act(() => {
      root.unmount();
    });
    root = ReactDOMClient.createRoot(container);
    await render({proposals: proposals(), storageKey: null});
    expect(rows()[0]).toEqual(['cart_add_item', 'proposed', 'selected']);
  });

  it('filters with chips and search', async () => {
    await render({proposals: proposals()});
    await click(buttonWithText('Needs attention'));
    expect(rows().map(row => row[0])).toEqual(['cart_clear']);
    await click(buttonWithText('Needs attention'));
    expect(rows()).toHaveLength(3);
    await setValue(container.querySelector('.rwr-SearchInput'), 'order');
    expect(rows().map(row => row[0])).toEqual(['checkout_place_order']);
    await setValue(container.querySelector('.rwr-SearchInput'), 'zzz');
    expect(rows()).toHaveLength(0);
    expect(text('.rwr-Empty')).toBe('No tools match this filter.');
  });

  it('bulk accepts the grounded proposals of a group', async () => {
    await render({proposals: proposals()});
    const action = buttonWithText('Accept 1 grounded');
    expect(action).not.toBe(undefined);
    await click(action);
    expect(rows()).toEqual([
      ['cart_add_item', 'accepted', ''],
      ['cart_clear', 'proposed', 'selected'],
      ['checkout_place_order', 'proposed', ''],
    ]);
    expect(buttonWithText('Accept 1 grounded').textContent).toContain(
      'Accept 1 grounded',
    );
  });

  it('regroups by scope and file', async () => {
    await render({proposals: proposals()});
    const select = container.querySelector('.rwr-Select select');
    const setter = Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      'value',
    ).set;
    await act(() => {
      setter.call(select, 'file');
      select.dispatchEvent(new Event('change', {bubbles: true}));
    });
    expect(
      Array.from(container.querySelectorAll('.rwr-GroupName')).map(
        node => node.textContent,
      ),
    ).toEqual(['src/Cart.js', 'src/Checkout.js']);
    expect(text('.rwr-ListFoot span')).toBe('3 tools in 2 files');
  });

  it('records a journey from the page and hands it back', async () => {
    const onRecordJourney = jest.fn();
    await render({proposals: proposals(), onRecordJourney});
    const page = document.createElement('div');
    page.innerHTML =
      '<input placeholder="Something to do" /><button type="button">Add</button>';
    document.body.appendChild(page);
    try {
      await click(buttonWithText('Record journey'));
      expect(container.querySelector('[role="dialog"]')).toBe(null);
      expect(text('.rwr-RecordPill')).toContain('Recording journey · 0 steps');
      const input = page.querySelector('input');
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      ).set;
      await act(() => {
        setter.call(input, 'Buy tea');
        input.dispatchEvent(new Event('change', {bubbles: true}));
        page.querySelector('button').click();
      });
      expect(text('.rwr-RecordPill')).toContain('2 steps');
      await click(buttonWithText('Stop and save'));
      expect(onRecordJourney).toHaveBeenCalledTimes(1);
      const journey = onRecordJourney.mock.calls[0][0];
      expect(journey.name).toMatch(/^journey-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}$/);
      expect(journey.steps).toEqual([
        {fill: 'Something to do', value: 'Buy tea'},
        {click: 'Add'},
      ]);
      expect(container.querySelector('[role="dialog"]')).not.toBe(null);
      // Cancel discards.
      await click(buttonWithText('Record journey'));
      await act(() => {
        page.querySelector('button').click();
      });
      await click(buttonWithText('Cancel'));
      expect(onRecordJourney).toHaveBeenCalledTimes(1);
      expect(container.querySelector('[role="dialog"]')).not.toBe(null);
    } finally {
      page.remove();
    }
  });
});
