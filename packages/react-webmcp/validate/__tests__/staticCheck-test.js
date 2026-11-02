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
  checkToolAgainstSource,
  findToolDefinitions,
} = require('react-webmcp/validate/staticCheck');

describe('react-webmcp static schema/handler check', () => {
  it('finds hook calls and Tool elements by name', () => {
    const source = `
      function TodoTools() {
        useWebMCPTool({name: 'add_todo', description: 'x', execute: ({text}) => text});
        return null;
      }
      function Cart() {
        return <ToolTree><Tool name="add_item" description="y" execute={({sku}) => sku} /></ToolTree>;
      }
    `;
    const definitions = findToolDefinitions(source);
    expect(definitions.map(d => [d.kind, d.name, d.component])).toEqual([
      ['hook', 'add_todo', 'TodoTools'],
      ['tree', 'add_item', 'Cart'],
    ]);
  });

  it('passes when the destructured parameters match the schema', () => {
    const source = `
      function TodoTools() {
        useWebMCPTool({
          name: 'add_todo',
          description: 'Add a todo.',
          inputSchema: {type: 'object', properties: {text: {type: 'string'}}, required: ['text']},
          execute: ({text}) => text,
        });
      }
    `;
    expect(checkToolAgainstSource(source, {toolName: 'add_todo'})).toEqual({
      status: 'ok',
      kind: 'hook',
      component: 'TodoTools',
      line: 3,
      declared: ['text'],
      used: ['text'],
      declaredButUnused: [],
      usedButUndeclared: [],
      requiredButUnused: [],
    });
  });

  it('reports parameters execute reads but the schema does not declare', () => {
    const source = `
      const Cart = () => (
        <Tool
          name="add_item"
          description="Add."
          inputSchema={{type: 'object', properties: {sku: {type: 'string'}}, required: ['sku']}}
          execute={({sku, quantity}) => sku + quantity}
        />
      );
    `;
    const result = checkToolAgainstSource(source, {toolName: 'add_item'});
    expect(result.status).toBe('mismatch');
    expect(result.component).toBe('Cart');
    expect(result.usedButUndeclared).toEqual(['quantity']);
    expect(result.declaredButUnused).toEqual([]);
  });

  it('reports required properties execute never reads', () => {
    const source = `
      function Search() {
        useWebMCPTool({
          name: 'search',
          description: 'Search.',
          inputSchema: {type: 'object', properties: {query: {type: 'string'}, limit: {type: 'number'}}, required: ['query', 'limit']},
          execute: ({query}) => query,
        });
      }
    `;
    const result = checkToolAgainstSource(source, {toolName: 'search'});
    expect(result.status).toBe('mismatch');
    expect(result.declaredButUnused).toEqual(['limit']);
    expect(result.requiredButUnused).toEqual(['limit']);
  });

  it('follows same-file identifiers for the schema and the handler', () => {
    const source = `
      const schema = {type: 'object', properties: {text: {type: 'string'}}};
      function handleAdd({text}) { return text; }
      function TodoTools() {
        useWebMCPTool({name: 'add_todo', description: 'Add.', inputSchema: schema, execute: handleAdd});
      }
    `;
    const result = checkToolAgainstSource(source, {toolName: 'add_todo'});
    expect(result.status).toBe('ok');
    expect(result.declared).toEqual(['text']);
    expect(result.used).toEqual(['text']);
  });

  it('skips shapes it cannot read instead of failing', () => {
    const whole = `
      function T() { useWebMCPTool({name: 'a', description: 'd', inputSchema: {type: 'object', properties: {x: {}}}, execute: input => input.x}); }
    `;
    expect(checkToolAgainstSource(whole, {toolName: 'a'}).status).toBe(
      'skipped',
    );

    const dynamicSchema = `
      import {schema} from './elsewhere';
      function T() { useWebMCPTool({name: 'a', description: 'd', inputSchema: schema, execute: ({x}) => x}); }
    `;
    expect(checkToolAgainstSource(dynamicSchema, {toolName: 'a'}).status).toBe(
      'skipped',
    );
  });

  it('prefers the definition inside the named component', () => {
    const source = `
      function First() { useWebMCPTool({name: 'go', description: 'd', execute: () => 1}); }
      function Second() { useWebMCPTool({name: 'go', description: 'd', inputSchema: {type: 'object', properties: {n: {}}}, execute: ({n}) => n}); }
    `;
    const result = checkToolAgainstSource(source, {
      toolName: 'go',
      componentName: 'Second',
    });
    expect(result.component).toBe('Second');
    expect(result.status).toBe('ok');
  });

  it('reports tools that are not in the file', () => {
    expect(
      checkToolAgainstSource('const x = 1;', {toolName: 'nope'}).status,
    ).toBe('not-found');
  });

  it('treats a tool without inputSchema that reads parameters as a mismatch', () => {
    const source = `
      function T() { useWebMCPTool({name: 'a', description: 'd', execute: ({x}) => x}); }
    `;
    const result = checkToolAgainstSource(source, {toolName: 'a'});
    expect(result.status).toBe('mismatch');
    expect(result.usedButUndeclared).toEqual(['x']);
  });
});
