/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails react-core
 */

'use strict';

const Model = require('react-webmcp/src/review/ReviewModel');
const {createProposal} = require('./utils/createProposal');

function liveRecord(overrides = {}) {
  const name = overrides.name || 'list_items';
  const scopePath = overrides.scopePath || ['cart'];
  return {
    key: scopePath.concat(name).join('_'),
    qualifiedName: scopePath.concat(name).join('_'),
    name,
    scopePath,
    description: overrides.description || 'List the cart.',
    inputSchema:
      overrides.inputSchema === undefined ? null : overrides.inputSchema,
    annotations: {readOnlyHint: true},
    safety: overrides.safety === undefined ? 'read' : overrides.safety,
    lifetime: 'view',
    source: overrides.source || 'tree',
    status: 'registered',
    availability: {
      enabled: true,
      scopeAvailable: true,
      hidden: false,
      supported: true,
    },
    error: null,
  };
}

describe('ReviewModel', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('applies edits and recomputes the qualified name', () => {
    const proposal = createProposal();
    expect(Model.applyEdits(proposal, null)).toBe(proposal);
    expect(
      Model.applyEdits(proposal, {description: proposal.description}),
    ).toBe(proposal);
    const edited = Model.applyEdits(proposal, {
      name: 'add_to_cart',
      safety: 'irreversible',
    });
    expect(edited.name).toBe('add_to_cart');
    expect(edited.qualifiedName).toBe('cart_add_to_cart');
    expect(edited.safety).toBe('irreversible');
    expect(proposal.name).toBe('add_item');
  });

  it('merges partial edits with later ones winning', () => {
    expect(Model.mergeEdits(null, null)).toEqual({});
    expect(Model.mergeEdits(undefined, {name: 'a'})).toEqual({name: 'a'});
    expect(Model.mergeEdits({lifetime: 'route'}, null)).toEqual({
      lifetime: 'route',
    });
    expect(
      Model.mergeEdits(
        {name: 'a', safety: 'read', description: 'Base.'},
        {name: 'b', lifetime: 'app'},
      ),
    ).toEqual({
      name: 'b',
      safety: 'read',
      description: 'Base.',
      lifetime: 'app',
    });
    // A field the patch leaves undefined keeps the base value; null is a
    // value (it removes the schema).
    expect(
      Model.mergeEdits(
        {description: 'keep', inputSchema: {type: 'object', properties: {}}},
        {description: undefined, inputSchema: null},
      ),
    ).toEqual({description: 'keep', inputSchema: null});
    // The inputs are not mutated.
    const base = {name: 'a'};
    Model.mergeEdits(base, {name: 'b'});
    expect(base).toEqual({name: 'a'});
  });

  it('applies a schema removal and leaves the proposal alone for no-op edits', () => {
    const proposal = createProposal();
    const removed = Model.applyEdits(proposal, {inputSchema: null});
    expect(removed).not.toBe(proposal);
    expect(removed.inputSchema).toBe(null);
    expect(proposal.inputSchema).not.toBe(null);
    const replaced = Model.applyEdits(proposal, {
      inputSchema: {type: 'object', properties: {}},
    });
    expect(replaced.inputSchema).toEqual({type: 'object', properties: {}});
    // Edits equal to the proposal, or undefined, change nothing.
    expect(
      Model.applyEdits(proposal, {
        name: proposal.name,
        description: proposal.description,
        safety: proposal.safety,
        lifetime: proposal.lifetime,
        inputSchema: proposal.inputSchema,
      }),
    ).toBe(proposal);
    expect(Model.applyEdits(proposal, {})).toBe(proposal);
    expect(Model.applyEdits(proposal, undefined)).toBe(proposal);
    expect(Model.applyEdits(proposal, {name: undefined})).toBe(proposal);
    const relifed = Model.applyEdits(proposal, {lifetime: 'app'});
    expect(relifed.lifetime).toBe('app');
    expect(relifed.qualifiedName).toBe(proposal.qualifiedName);
  });

  it('summarizes checks without counting pending ones', () => {
    const checks = Model.summarizeChecks([
      {check: 'binding', level: 'ok', summary: ''},
      {check: 'schema', level: 'warn', summary: ''},
      {check: 'replay', level: 'pending', summary: ''},
      {check: 'trace', level: 'ok', summary: ''},
    ]);
    expect(checks).toEqual({ok: 2, total: 3, hasWarn: true, hasBad: false});
  });

  it('derives statuses from decisions, evidence and the live registry', () => {
    const plain = createProposal();
    const warned = createProposal({
      name: 'clear',
      handler: 'clearCart',
      evidence: [
        {check: 'binding', level: 'ok', summary: 'ok'},
        {
          check: 'schema',
          level: 'warn',
          summary: 'quantity is never read',
          property: 'quantity',
        },
      ],
    });
    const broken = createProposal({
      name: 'apply_coupon',
      handler: 'applyCoupon',
      evidence: [{check: 'binding', level: 'bad', summary: 'no such handler'}],
    });
    const implemented = createProposal({
      name: 'list_items',
      handler: null,
      kind: 'existing-tool-element',
      status: 'exported',
    });
    const decisions = new Map([
      [
        plain.id,
        {
          id: plain.id,
          status: 'accepted',
          edits: {description: 'Edited.'},
          decidedAt: '',
        },
      ],
    ]);
    const entries = Model.buildEntries(
      [plain, warned, broken, implemented],
      [liveRecord({name: 'get_total', source: 'hook'})],
      decisions,
    );
    expect(
      entries.map(entry => [entry.tool.qualifiedName, entry.status]),
    ).toEqual([
      ['cart_add_item', 'accepted'],
      ['cart_clear', 'proposed'],
      ['cart_apply_coupon', 'ungrounded'],
      ['cart_list_items', 'exported'],
      ['cart_get_total', 'exported'],
    ]);
    expect(entries[0].tool.description).toBe('Edited.');
    expect(entries[0].original.description).toBe(plain.description);
    expect(entries.map(entry => entry.needsAttention)).toEqual([
      false,
      true,
      true,
      false,
      false,
    ]);
    const live = entries[4];
    expect(live.live).toBe(true);
    expect(live.id).toBe('live:cart_get_total');
    expect(live.tool.binding.kind).toBe('existing-hook');
    expect(live.tool.safety).toBe('read');
  });

  it('treats a proposal as exported once the page registers its name', () => {
    const proposal = createProposal();
    const entries = Model.buildEntries(
      [proposal],
      [liveRecord({name: 'add_item', safety: 'mutate'})],
      new Map(),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe('exported');
    expect(entries[0].live).toBe(true);
  });

  it('groups by route, scope or file with sorted keys and counts', () => {
    const entries = Model.buildEntries(
      [
        createProposal({
          route: '/checkout',
          name: 'place_order',
          scopePath: [],
        }),
        createProposal({route: '/cart'}),
        createProposal({
          route: '/cart',
          name: 'clear',
          handler: 'clearCart',
          evidence: [{check: 'binding', level: 'warn', summary: 'from props'}],
        }),
      ],
      [],
      new Map(),
    );
    const byRoute = Model.groupEntries(entries, 'route');
    expect(byRoute.map(group => [group.key, group.entries.length])).toEqual([
      ['/cart', 2],
      ['/checkout', 1],
    ]);
    expect(byRoute[0].groundedProposed).toBe(1);
    expect(
      Model.groupEntries(entries, 'scope').map(group => group.key),
    ).toEqual(['/', '/cart']);
    expect(Model.groupEntries(entries, 'file').map(group => group.key)).toEqual(
      ['src/Cart.js'],
    );
  });

  it('filters by query and chip and counts chips', () => {
    const entries = Model.buildEntries(
      [
        createProposal(),
        createProposal({
          name: 'clear',
          handler: 'clearCart',
          description: 'Remove every item.',
          evidence: [{check: 'binding', level: 'warn', summary: 'from props'}],
        }),
      ],
      [],
      new Map([
        [
          createProposal().id,
          {
            id: createProposal().id,
            status: 'accepted',
            edits: {},
            decidedAt: '',
          },
        ],
      ]),
    );
    expect(
      Model.filterEntries(entries, 'remove', null).map(e => e.tool.name),
    ).toEqual(['clear']);
    expect(
      Model.filterEntries(entries, 'clearCart', null).map(e => e.tool.name),
    ).toEqual(['clear']);
    expect(
      Model.filterEntries(entries, '', 'accepted').map(e => e.tool.name),
    ).toEqual(['add_item']);
    expect(
      Model.filterEntries(entries, '', 'attention').map(e => e.tool.name),
    ).toEqual(['clear']);
    expect(Model.chipCounts(entries)).toEqual({
      proposed: 1,
      accepted: 1,
      attention: 1,
      exported: 0,
    });
  });

  it('measures progress over reviewable entries only', () => {
    const a = createProposal();
    const b = createProposal({name: 'clear', handler: 'clearCart'});
    const c = createProposal({name: 'list', handler: null, status: 'exported'});
    const entries = Model.buildEntries(
      [a, b, c],
      [],
      new Map([
        [b.id, {id: b.id, status: 'rejected', edits: {}, decidedAt: ''}],
      ]),
    );
    expect(Model.progressOf(entries)).toEqual({
      reviewed: 1,
      reviewable: 2,
      percent: 50,
    });
  });

  it('finds the next undecided entry, wrapping around', () => {
    const a = createProposal({name: 'a', handler: 'a'});
    const b = createProposal({name: 'b', handler: 'b'});
    const c = createProposal({name: 'c', handler: 'c'});
    const entries = Model.buildEntries(
      [a, b, c],
      [],
      new Map([
        [b.id, {id: b.id, status: 'accepted', edits: {}, decidedAt: ''}],
      ]),
    );
    expect(Model.nextUndecidedId(entries, a.id)).toBe(c.id);
    expect(Model.nextUndecidedId(entries, c.id)).toBe(a.id);
    expect(Model.nextUndecidedId(entries, null)).toBe(a.id);
    expect(Model.nextUndecidedId([entries[1]], b.id)).toBe(null);
  });

  it('exports accepted tools with their edits and the rejected ids', () => {
    const a = createProposal();
    const b = createProposal({name: 'clear', handler: 'clearCart'});
    const entries = Model.buildEntries(
      [a, b],
      [],
      new Map([
        [
          a.id,
          {
            id: a.id,
            status: 'accepted',
            edits: {name: 'add_to_cart', safety: 'irreversible'},
            decidedAt: '',
          },
        ],
        [b.id, {id: b.id, status: 'rejected', edits: {}, decidedAt: ''}],
      ]),
    );
    const data = Model.buildExport(entries, new Date('2026-11-01T13:00:00Z'));
    expect(data.version).toBe(1);
    expect(data.exportedAt).toBe('2026-11-01T13:00:00.000Z');
    expect(data.rejected).toEqual([b.id]);
    expect(data.accepted).toHaveLength(1);
    expect(data.accepted[0]).toMatchObject({
      id: a.id,
      name: 'add_to_cart',
      qualifiedName: 'cart_add_to_cart',
      safety: 'irreversible',
      status: 'accepted',
    });
  });

  it('round-trips schema rows', () => {
    const proposal = createProposal();
    const rows = Model.schemaRows(proposal.inputSchema);
    expect(rows).toEqual([
      {
        name: 'sku',
        type: 'string',
        required: true,
        description: 'SKU of the item.',
      },
      {
        name: 'quantity',
        type: 'number',
        required: false,
        description: 'How many to add.',
      },
    ]);
    expect(Model.schemaFromRows(rows)).toEqual(proposal.inputSchema);
    expect(Model.schemaFromRows([])).toBe(null);
    expect(
      Model.schemaFromRows([
        {name: '  ', type: 'string', required: true, description: ''},
      ]),
    ).toBe(null);
    expect(Model.schemaRows(null)).toEqual([]);
  });

  it('maps schema warnings onto properties', () => {
    const flags = Model.propertyFlags([
      {check: 'binding', level: 'ok', summary: ''},
      {
        check: 'schema',
        level: 'warn',
        summary: 'quantity is never read',
        property: 'quantity',
      },
      {check: 'schema', level: 'ok', summary: 'sku is read', property: 'sku'},
    ]);
    expect(Array.from(flags.keys())).toEqual(['quantity']);
  });

  it('persists decisions in localStorage and survives bad data', () => {
    const decisions = new Map([
      ['x', {id: 'x', status: 'accepted', edits: {name: 'y'}, decidedAt: 't'}],
      ['z', {id: 'z', status: 'rejected', edits: {}, decidedAt: 't'}],
    ]);
    Model.saveDecisions('demo', decisions);
    expect(Array.from(Model.loadDecisions('demo').entries())).toEqual(
      Array.from(decisions.entries()),
    );
    localStorage.setItem('react-webmcp:review:broken', '{not json');
    expect(Model.loadDecisions('broken').size).toBe(0);
    localStorage.setItem(
      'react-webmcp:review:mixed',
      JSON.stringify([
        {id: 'ok', status: 'accepted'},
        {id: 'bad', status: 'maybe'},
      ]),
    );
    const mixed = Model.loadDecisions('mixed');
    expect(Array.from(mixed.keys())).toEqual(['ok']);
    expect(mixed.get('ok').edits).toEqual({});
  });

  it('describes when a proposal was inferred', () => {
    const now = new Date('2026-11-01T12:10:00Z');
    expect(Model.describeTimeSince('2026-11-01T12:09:50Z', now)).toBe(
      'inferred just now',
    );
    expect(Model.describeTimeSince('2026-11-01T12:00:00Z', now)).toBe(
      'inferred 10 min ago',
    );
    expect(Model.describeTimeSince('2026-11-01T09:00:00Z', now)).toBe(
      'inferred 3 h ago',
    );
    expect(Model.describeTimeSince('2026-10-25T12:00:00Z', now)).toBe(
      'inferred 7 days ago',
    );
    expect(Model.describeTimeSince('', now)).toBe('');
    expect(Model.describeTimeSince('nope', now)).toBe('');
  });

  it('labels irreversible as consequential', () => {
    expect(Model.safetyLabel('read')).toBe('read');
    expect(Model.safetyLabel('mutate')).toBe('mutate');
    expect(Model.safetyLabel('irreversible')).toBe('consequential');
  });

  it('builds editor links for source locations', () => {
    const location = {file: 'src/Cart.js', line: 42, column: 7};
    expect(Model.editorUrlFor(null, '/app', location)).toBe(null);
    // Editor schemes take the absolute path after "file/", hence the //.
    expect(Model.editorUrlFor('vscode', '/app/', location)).toBe(
      'vscode://file//app/src/Cart.js:42:7',
    );
    expect(Model.editorUrlFor('cursor', null, location)).toBe(
      'cursor://file/src/Cart.js:42:7',
    );
    expect(
      Model.editorUrlFor('zed', '/app', {
        file: '/abs/File.js',
        line: 0,
        column: 0,
      }),
    ).toBe('zed://file//abs/File.js:1:1');
    expect(Model.editorUrlFor('idea', '/app', location)).toBe(
      'idea://open?file=%2Fapp%2Fsrc%2FCart.js&line=42&column=7',
    );
    expect(
      Model.editorUrlFor(loc => 'custom:' + loc.file, '/app', location),
    ).toBe('custom:src/Cart.js');
  });
});
