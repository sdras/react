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
    Registry.upsertToolRecord(record());
    Registry.upsertToolRecord(record({key: 'other', qualifiedName: 'other'}));
    Registry.removeToolRecord('other');
    expect(calls).toEqual([1, 2, 1]);
    unsubscribe();
    Registry.removeToolRecord('add_item');
    expect(calls).toEqual([1, 2, 1]);
  });

  it('batches notifications', () => {
    const calls = [];
    Registry.subscribeToRegisteredTools(() => {
      calls.push(Registry.getRegisteredTools().length);
    });
    Registry.batchToolRecordUpdates(() => {
      Registry.upsertToolRecord(record());
      Registry.upsertToolRecord(record({key: 'b', qualifiedName: 'b'}));
    });
    expect(calls).toEqual([2]);
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
      Registry.upsertToolRecord(record({key: 'other', qualifiedName: 'other'}));
      expect(globalThis.__REACT_WEBMCP__.getTools()).toHaveLength(2);
    } else {
      expect(globalThis.__REACT_WEBMCP__).toBeUndefined();
    }
  });

  it('warns once about two tools sharing an agent-facing name', () => {
    Registry.upsertToolRecord(record());
    Registry.upsertToolRecord(record({key: 'second'}));
    assertConsoleErrorDev(
      [
        'WebMCP: Two tools are registered with the name "add_item". ' +
          'Agents cannot tell them apart. Give each one a unique `key` and a ' +
          'distinct name, or wrap them in a <ToolScope name> to prefix it.',
      ],
      {withoutStack: true},
    );
    // Reporting the same problem again is silent.
    Registry.upsertToolRecord(record({key: 'second', status: 'disabled'}));
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
});
