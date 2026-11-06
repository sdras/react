/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails react-core
 */

'use strict';

let Registry;
let Validation;
let assertConsoleErrorDev;
let assertConsoleWarnDev;

const OWNER_TOKEN = {current: null};

// A record from another component: a different owner token.
function other(overrides) {
  return record({ownerToken: {current: null}, ...overrides});
}

function record(overrides) {
  return {
    key: 'add_item',
    qualifiedName: 'add_item',
    name: 'add_item',
    scopePath: [],
    description: 'Add an item to the cart.',
    inputSchema: {
      type: 'object',
      properties: {sku: {type: 'string', description: 'Product SKU'}},
      required: ['sku'],
    },
    annotations: {},
    safety: 'mutate',
    lifetime: 'view',
    source: 'hook',
    status: 'registered',
    availability: {
      enabled: true,
      scopeAvailable: true,
      hidden: false,
      supported: true,
    },
    error: null,
    ownerToken: OWNER_TOKEN,
    ...overrides,
  };
}

describe('ReactDOM WebMCP registry', () => {
  beforeEach(() => {
    jest.resetModules();
    delete globalThis.__REACT_WEBMCP__;
    ({
      assertConsoleErrorDev,
      assertConsoleWarnDev,
    } = require('internal-test-utils'));
    Registry = require('react-dom/src/shared/webmcp/ReactDOMWebMCPRegistry');
    Validation = require('react-dom/src/shared/webmcp/ReactDOMWebMCPValidation');
    Registry.resetRegistryForTesting();
    Validation.resetReportedIssuesForTesting();
  });

  it('exposes public records without owner tokens and keeps the snapshot stable', () => {
    Registry.upsertToolRecord(record());
    const first = Registry.getRegisteredTools();
    expect(first).toHaveLength(1);
    expect(first[0].qualifiedName).toBe('add_item');
    expect('ownerToken' in first[0]).toBe(false);
    // Unchanged registry returns the same array instance.
    expect(Registry.getRegisteredTools()).toBe(first);
    // An identical upsert is a no-op.
    Registry.upsertToolRecord(record());
    expect(Registry.getRegisteredTools()).toBe(first);
    Registry.upsertToolRecord(record({status: 'disabled'}));
    expect(Registry.getRegisteredTools()).not.toBe(first);
    expect(Registry.getRegisteredTools()[0].status).toBe('disabled');
  });

  it('notifies subscribers on change and stops after unsubscribe', () => {
    const calls = [];
    const unsubscribe = Registry.subscribeToRegisteredTools(() => {
      calls.push(Registry.getRegisteredTools().length);
    });
    const second = other({key: 'other', qualifiedName: 'other'});
    Registry.upsertToolRecord(record());
    Registry.upsertToolRecord(second);
    Registry.removeToolRecord(second.ownerToken);
    expect(calls).toEqual([1, 2, 1]);
    // Removing an owner without a record is not a change.
    Registry.removeToolRecord(second.ownerToken);
    expect(calls).toEqual([1, 2, 1]);
    unsubscribe();
    Registry.removeToolRecord(OWNER_TOKEN);
    expect(calls).toEqual([1, 2, 1]);
  });

  it('batches notifications', () => {
    const calls = [];
    Registry.subscribeToRegisteredTools(() => {
      calls.push(Registry.getRegisteredTools().length);
    });
    Registry.batchToolRecordUpdates(() => {
      Registry.upsertToolRecord(record());
      Registry.upsertToolRecord(other({key: 'b', qualifiedName: 'b'}));
    });
    expect(calls).toEqual([2]);
  });

  it('keeps one record per owner and reads them back by owner', () => {
    expect(Registry.upsertToolRecord(record())).toBe(true);
    expect(Registry.upsertToolRecord(record())).toBe(false);
    // The owner renamed its tool: the old key goes with it.
    expect(
      Registry.upsertToolRecord(record({key: 'renamed', qualifiedName: 'x'})),
    ).toBe(true);
    expect(Registry.getRegisteredTools().map(t => t.key)).toEqual(['renamed']);
    expect(Registry.getToolRecord(OWNER_TOKEN).key).toBe('renamed');
    expect(Registry.getToolRecord({current: null})).toBe(undefined);
    Registry.removeToolRecord(OWNER_TOKEN);
    expect(Registry.getRegisteredTools()).toHaveLength(0);
  });

  it('shows the live, most recently written record for a contested key', () => {
    const second = other({description: 'Second.'});
    Registry.upsertToolRecord(record());
    Registry.upsertToolRecord(second);
    expect(Registry.getRegisteredTools().map(t => t.description)).toEqual([
      'Second.',
    ]);
    // A hidden record never outranks a live one, however recent.
    Registry.upsertToolRecord({
      ...second,
      status: 'unavailable',
      availability: {...second.availability, hidden: true},
    });
    expect(Registry.getRegisteredTools().map(t => t.description)).toEqual([
      'Add an item to the cart.',
    ]);
    Registry.removeToolRecord(OWNER_TOKEN);
    expect(Registry.getRegisteredTools().map(t => t.description)).toEqual([
      'Second.',
    ]);
  });

  it('installs a DEV-only global handle for developer tooling on first use', () => {
    // Nothing is exposed until a tool exists.
    expect(globalThis.__REACT_WEBMCP__).toBeUndefined();
    Registry.upsertToolRecord(record());
    if (__DEV__) {
      const internal = globalThis.__REACT_WEBMCP__.getTools();
      expect(internal).toHaveLength(1);
      expect(internal[0].ownerToken).toBe(OWNER_TOKEN);
      // A deleted handle is reinstalled by the next record; a foreign one is
      // replaced without a warning.
      delete globalThis.__REACT_WEBMCP__;
      Registry.upsertToolRecord(other({key: 'other', qualifiedName: 'other'}));
      expect(globalThis.__REACT_WEBMCP__.getTools()).toHaveLength(2);
    } else {
      expect(globalThis.__REACT_WEBMCP__).toBeUndefined();
    }
  });

  it('warns once about two tools sharing an agent-facing name', () => {
    Registry.upsertToolRecord(record());
    Registry.upsertToolRecord(other({key: 'second'}));
    assertConsoleErrorDev(
      [
        'WebMCP: Two tools are registered with the name "add_item". ' +
          'Agents cannot tell them apart. Give each one a unique `key` and a ' +
          'distinct name, or wrap them in a <ToolScope name> to prefix it.',
      ],
      {withoutStack: true},
    );
    // Reporting the same problem again is silent.
    Registry.upsertToolRecord(other({key: 'second', status: 'disabled'}));
  });

  it('flags required schema properties that are not declared', () => {
    Registry.upsertToolRecord(
      record({
        inputSchema: {
          type: 'object',
          properties: {sku: {type: 'string'}},
          required: ['sku', 'quantity'],
        },
      }),
    );
    assertConsoleErrorDev(
      [
        'WebMCP: The inputSchema of "add_item" marks "quantity" as ' +
          'required but does not declare it in `properties`.',
      ],
      {withoutStack: true},
    );
  });

  it('warns about missing safety and oversized text budgets', () => {
    Registry.upsertToolRecord(
      record({
        key: 'long',
        name: 'a_very_long_tool_name_that_goes_past_thirty',
        qualifiedName: 'a_very_long_tool_name_that_goes_past_thirty',
        safety: null,
        description: 'x'.repeat(501),
        inputSchema: {
          type: 'object',
          properties: {sku: {type: 'string', description: 'y'.repeat(151)}},
        },
      }),
    );
    assertConsoleWarnDev(
      [
        'WebMCP: The tool name "a_very_long_tool_name_that_goes_past_thirty" is longer than 30 characters. Prefer short, action-oriented names like "add_item".',
        'WebMCP: The description of "a_very_long_tool_name_that_goes_past_thirty" is longer than 500 characters. Agents may truncate it.',
        'WebMCP: The description of parameter "sku" on "a_very_long_tool_name_that_goes_past_thirty" is longer than 150 characters.',
        'WebMCP: The tool "a_very_long_tool_name_that_goes_past_thirty" does not declare `safety`. Agents assume a tool mutates state unless it is marked "read", and ask the user before running one marked "irreversible".',
      ],
      {withoutStack: true},
    );
  });
  it('reports a key held by two owners when the writer asks, once per pair', () => {
    const collisionMessage =
      'WebMCP: Two components registered a tool named "add_item" without ' +
      'distinct keys. Agents cannot tell them apart, and developer tooling ' +
      'only keeps the most recent one. Give them distinct names, wrap one ' +
      'in a <ToolScope name> to prefix it, or set a unique `key` on each ' +
      'useWebMCPTool call (`id` on <Tool>).';
    const second = other();
    Registry.upsertToolRecord(record());
    // Writing never reports on its own: the writer's commit may still be
    // removing the record of a component it replaced.
    Registry.upsertToolRecord(second);
    Registry.checkToolRecordCollisions(second.ownerToken);
    assertConsoleErrorDev([collisionMessage], {withoutStack: true});
    // The same pair, from either side, is reported once.
    Registry.checkToolRecordCollisions(second.ownerToken);
    Registry.checkToolRecordCollisions(OWNER_TOKEN);
    // A hidden record (a Suspense fallback) still holds the key.
    Registry.upsertToolRecord({
      ...second,
      status: 'unavailable',
      availability: {...second.availability, hidden: true},
    });
    Registry.checkToolRecordCollisions(OWNER_TOKEN);

    // After one side leaves, a new instance colliding on the same key is a
    // new problem.
    Registry.removeToolRecord(second.ownerToken);
    const third = other();
    Registry.upsertToolRecord(third);
    Registry.checkToolRecordCollisions(third.ownerToken);
    assertConsoleErrorDev([collisionMessage], {withoutStack: true});

    // An owner that no longer holds a record has nothing to check.
    Registry.removeToolRecord(OWNER_TOKEN);
    Registry.checkToolRecordCollisions(OWNER_TOKEN);
    Registry.checkToolRecordCollisions(third.ownerToken);
  });

  it('does not report a replacement whose predecessor left before the check', () => {
    const successor = other();
    Registry.upsertToolRecord(record());
    Registry.upsertToolRecord({
      ...record(),
      status: 'unavailable',
      availability: {...record().availability, hidden: true},
    });
    Registry.upsertToolRecord(successor);
    Registry.removeToolRecord(OWNER_TOKEN);
    Registry.checkToolRecordCollisions(successor.ownerToken);
    expect(Registry.getRegisteredTools()).toHaveLength(1);
  });
});
