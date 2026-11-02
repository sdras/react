/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

'use strict';

// `infer emit`: a codemod that inserts a marked `useWebMCPTool` skeleton for
// each accepted proposal at the top of its component. It splices text by AST
// positions so untouched code keeps its formatting, verifies that the result
// still parses, and is idempotent: a tool whose name already exists in the
// file is skipped. Nothing here publishes a tool; the developer reviews the
// diff (dry run by default) and the inserted block before shipping it.

import type {
  ProposalInputSchema,
  ProposalsFile,
  ReviewExport,
  ToolProposal,
} from '../src/ReactWebMCPProposalTypes';

const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;

const {
  getJSXAttribute,
  getObjectProperty,
  isToolElement,
  isUseWebMCPToolCall,
  resolveExpression,
  stringValue,
} = require('../validate/staticCheck');
const {functionName, parseSource, parserPluginsFor} = require('./extract.flow');

type Node = any;
type NodePath = any;
type Edit = {start: number, end: number, text: string};
type Skipped = {id: string, name: string, reason: string};
type Inserted = {id: string, name: string, component: string};
type FilePlan = {
  // Relative to the source directory, as recorded in the binding.
  file: string,
  absolutePath: string | null,
  before: string,
  after: string,
  inserted: Array<Inserted>,
  skipped: Array<Skipped>,
  error: string | null,
};
type DiffOp = {type: ' ' | '-' | '+', text: string};

const MARKER = 'react-webmcp: proposed by `yarn infer-tools`';
const IMPORT_SOURCE = 'react-webmcp';
const HOOK_NAME = 'useWebMCPTool';
const DIFF_CONTEXT = 3;

/** Formatting */

function quote(text: string): string {
  return (
    "'" +
    text
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'")
      .replace(/\r/g, '\\r')
      .replace(/\n/g, '\\n') +
    "'"
  );
}

function formatKey(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : quote(key);
}

function formatSchema(schema: ProposalInputSchema): Array<string> {
  const lines = ['{', `  type: ${quote(schema.type)},`];
  const names = Object.keys(schema.properties);
  if (names.length === 0) {
    lines.push('  properties: {},');
  } else {
    lines.push('  properties: {');
    for (let i = 0; i < names.length; i++) {
      const property = schema.properties[names[i]];
      lines.push(
        `    ${formatKey(names[i])}: {type: ${quote(
          property.type,
        )}, description: ${quote(property.description)}},`,
      );
    }
    lines.push('  },');
  }
  lines.push(`  required: [${schema.required.map(quote).join(', ')}],`);
  lines.push('}');
  return lines;
}

function executeLines(proposal: ToolProposal): {
  lines: Array<string>,
  todo: string | null,
} {
  const binding = proposal.binding;
  if (binding.kind === 'form') {
    const target =
      binding.handler != null ? binding.handler : 'the onSubmit handler';
    return {
      lines: [
        'execute: input => {',
        `  /* TODO: submit ${target} with input */`,
        '},',
      ],
      todo: `TODO: forms need your judgment; wire execute to ${target}.`,
    };
  }
  if (binding.handler == null) {
    const where = `${binding.file}:${binding.line}`;
    return {
      lines: [
        'execute: () => {',
        `  /* TODO: call the inline handler at ${where} */`,
        '},',
      ],
      todo: `TODO: the handler is an inline arrow at ${where}; move its body here.`,
    };
  }
  const handler = binding.handler;
  if (binding.paramStyle === 'object') {
    return {lines: [`execute: input => ${handler}(input),`], todo: null};
  }
  if (binding.paramStyle === 'positional' && binding.params.length > 0) {
    const schemaNames =
      proposal.inputSchema != null
        ? Object.keys(proposal.inputSchema.properties)
        : [];
    const names =
      schemaNames.length === binding.params.length
        ? schemaNames
        : binding.params;
    const list = names.join(', ');
    return {
      lines: [`execute: ({${list}}) => ${handler}(${list}),`],
      todo: null,
    };
  }
  return {lines: [`execute: () => ${handler}(),`], todo: null};
}

function hookBlock(proposal: ToolProposal): Array<string> {
  const lines = [`// ${MARKER} (id ${proposal.id}). Review before shipping.`];
  const execute = executeLines(proposal);
  if (execute.todo != null) {
    lines.push(`// ${execute.todo}`);
  }
  lines.push(`${HOOK_NAME}({`);
  lines.push(`  name: ${quote(proposal.name)},`);
  lines.push(`  description: ${quote(proposal.description)},`);
  lines.push(`  safety: ${quote(proposal.safety)},`);
  if (proposal.inputSchema != null) {
    const schemaLines = formatSchema(proposal.inputSchema);
    lines.push(`  inputSchema: ${schemaLines[0]}`);
    for (let i = 1; i < schemaLines.length - 1; i++) {
      lines.push(`  ${schemaLines[i]}`);
    }
    lines.push(`  ${schemaLines[schemaLines.length - 1]},`);
  }
  for (let i = 0; i < execute.lines.length; i++) {
    lines.push(`  ${execute.lines[i]}`);
  }
  lines.push('});');
  return lines;
}

/** Source inspection */

function existingToolNames(ast: Node): Set<string> {
  const names: Set<string> = new Set();
  traverse(ast, {
    CallExpression(callPath: NodePath) {
      const node = callPath.node;
      if (!isUseWebMCPToolCall(node) || node.arguments.length === 0) {
        return;
      }
      const options = resolveExpression(node.arguments[0], callPath);
      if (options == null || options.type !== 'ObjectExpression') {
        return;
      }
      const nameProperty = getObjectProperty(options, 'name');
      const name =
        nameProperty == null ? null : stringValue(nameProperty.value);
      if (name != null) {
        names.add(name);
      }
    },
    JSXElement(elementPath: NodePath) {
      const opening = elementPath.node.openingElement;
      if (!isToolElement(opening)) {
        return;
      }
      const name = stringValue(getJSXAttribute(opening, 'name'));
      if (name != null) {
        names.add(name);
      }
    },
  });
  return names;
}

function findComponentFunction(ast: Node, componentName: string): Node | null {
  let found: Node | null = null;
  traverse(ast, {
    'FunctionDeclaration|FunctionExpression|ArrowFunctionExpression'(
      fnPath: NodePath,
    ) {
      if (functionName(fnPath) === componentName) {
        found = fnPath.node;
        fnPath.stop();
      }
    },
  });
  return found;
}

function lineIndent(source: string, position: number): string {
  const lineStart = source.lastIndexOf('\n', position - 1) + 1;
  const match = /^[ \t]*/.exec(source.slice(lineStart, position));
  return match == null ? '' : match[0];
}

function bodyIndent(source: string, fn: Node): string {
  const body = fn.body;
  if (body.body.length > 0) {
    const first = body.body[0];
    const lineStart = source.lastIndexOf('\n', first.start - 1) + 1;
    const prefix = source.slice(lineStart, first.start);
    if (/^[ \t]*$/.test(prefix)) {
      return prefix;
    }
  }
  return lineIndent(source, fn.start) + '  ';
}

function planImportEdit(ast: Node): Edit | null {
  const body = ast.program.body;
  let lastImport: Node | null = null;
  for (let i = 0; i < body.length; i++) {
    const statement = body[i];
    if (statement.type !== 'ImportDeclaration') {
      continue;
    }
    lastImport = statement;
    if (
      statement.source.value !== IMPORT_SOURCE ||
      statement.importKind === 'type' ||
      statement.importKind === 'typeof'
    ) {
      continue;
    }
    const specifiers = statement.specifiers;
    if (
      specifiers.some(
        specifier =>
          specifier.local != null && specifier.local.name === HOOK_NAME,
      )
    ) {
      return null;
    }
    const named = specifiers.filter(
      specifier => specifier.type === 'ImportSpecifier',
    );
    if (named.length > 0) {
      const last = named[named.length - 1];
      return {start: last.end, end: last.end, text: `, ${HOOK_NAME}`};
    }
    const defaultSpecifier = specifiers.find(
      specifier => specifier.type === 'ImportDefaultSpecifier',
    );
    if (defaultSpecifier !== undefined) {
      return {
        start: defaultSpecifier.end,
        end: defaultSpecifier.end,
        text: `, {${HOOK_NAME}}`,
      };
    }
  }
  const text = `import {${HOOK_NAME}} from '${IMPORT_SOURCE}';`;
  if (lastImport != null) {
    return {start: lastImport.end, end: lastImport.end, text: `\n${text}`};
  }
  const start = body.length > 0 ? body[0].start : 0;
  return {start, end: start, text: `${text}\n\n`};
}

function applyEdits(source: string, edits: Array<Edit>): string {
  const ordered = edits.slice().sort((a, b) => b.start - a.start);
  let result = source;
  for (let i = 0; i < ordered.length; i++) {
    const edit = ordered[i];
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  return result;
}

function parseStrict(source: string, file: string): void {
  parser.parse(source, {
    sourceType: 'module',
    plugins: parserPluginsFor(file),
    allowReturnOutsideFunction: true,
  });
}

/** Planning */

function compareByName(a: ToolProposal, b: ToolProposal): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

// Pure: returns the edited source for one file without touching the disk.
function planEmitForSource(
  source: string,
  proposals: Array<ToolProposal>,
  options: {file: string},
): FilePlan {
  const file = options.file;
  const plan: FilePlan = {
    file,
    absolutePath: null,
    before: source,
    after: source,
    inserted: [],
    skipped: [],
    error: null,
  };
  let ast: Node;
  try {
    ast = parseSource(source, file);
  } catch (error) {
    plan.error = `could not parse ${file}: ${error.message}`;
    return plan;
  }
  const names = existingToolNames(ast);
  const byComponent: Map<string, Array<ToolProposal>> = new Map();
  const sorted = proposals.slice().sort(compareByName);
  for (let i = 0; i < sorted.length; i++) {
    const proposal = sorted[i];
    const binding = proposal.binding;
    if (binding.kind !== 'handler' && binding.kind !== 'form') {
      plan.skipped.push({
        id: proposal.id,
        name: proposal.name,
        reason: 'already implemented in source',
      });
      continue;
    }
    if (names.has(proposal.name) || names.has(proposal.qualifiedName)) {
      plan.skipped.push({
        id: proposal.id,
        name: proposal.name,
        reason: `already defined in ${file}`,
      });
      continue;
    }
    if (binding.component == null) {
      plan.skipped.push({
        id: proposal.id,
        name: proposal.name,
        reason: 'no owning component recorded in the binding',
      });
      continue;
    }
    names.add(proposal.name);
    const componentName = binding.component;
    if (componentName == null) {
      // Unreachable: the guard above already skipped unowned bindings.
      continue;
    }
    const list = byComponent.get(componentName) || [];
    list.push(proposal);
    byComponent.set(componentName, list);
  }

  const edits: Array<Edit> = [];
  byComponent.forEach((list, componentName) => {
    const fn = findComponentFunction(ast, componentName);
    const skipAll = (reason: string) => {
      for (let i = 0; i < list.length; i++) {
        plan.skipped.push({id: list[i].id, name: list[i].name, reason});
      }
    };
    if (fn == null) {
      skipAll(`component ${componentName} was not found in ${file}`);
      return;
    }
    if (fn.body.type !== 'BlockStatement') {
      skipAll(
        `component ${componentName} has an expression body; give it a block body first`,
      );
      return;
    }
    const indent = bodyIndent(source, fn);
    const blocks = list.map(proposal =>
      hookBlock(proposal)
        .map(line => (line === '' ? '' : indent + line))
        .join('\n'),
    );
    const position = fn.body.start + 1;
    edits.push({
      start: position,
      end: position,
      text: `\n${blocks.join('\n\n')}\n`,
    });
    for (let i = 0; i < list.length; i++) {
      plan.inserted.push({
        id: list[i].id,
        name: list[i].name,
        component: componentName,
      });
    }
  });
  if (plan.inserted.length === 0) {
    return plan;
  }
  const importEdit = planImportEdit(ast);
  if (importEdit != null) {
    edits.push(importEdit);
  }
  const after = applyEdits(source, edits);
  try {
    parseStrict(after, file);
  } catch (error) {
    plan.error = `the edited ${file} does not parse (${error.message}); nothing will be written`;
    for (let i = 0; i < plan.inserted.length; i++) {
      plan.skipped.push({
        id: plan.inserted[i].id,
        name: plan.inserted[i].name,
        reason: 'the edit did not produce valid code',
      });
    }
    plan.inserted = [];
    return plan;
  }
  plan.after = after;
  return plan;
}

// Reads the owner files from disk and plans every edit; nothing is written.
function planEmit(
  accepted: Array<ToolProposal>,
  options: {srcDir: string},
): Array<FilePlan> {
  const byFile: Map<string, Array<ToolProposal>> = new Map();
  for (let i = 0; i < accepted.length; i++) {
    const proposal = accepted[i];
    const list = byFile.get(proposal.binding.file) || [];
    list.push(proposal);
    byFile.set(proposal.binding.file, list);
  }
  const files = Array.from(byFile.keys()).sort();
  const plans: Array<FilePlan> = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const absolutePath = path.resolve(options.srcDir, file);
    const proposals = byFile.get(file) || [];
    if (!fs.existsSync(absolutePath)) {
      plans.push({
        file,
        absolutePath,
        before: '',
        after: '',
        inserted: [],
        skipped: proposals.map(proposal => ({
          id: proposal.id,
          name: proposal.name,
          reason: 'file not found',
        })),
        error: `${file} was not found under ${options.srcDir}; pass --src <dir> (the directory extract was run on)`,
      });
      continue;
    }
    const source = fs.readFileSync(absolutePath, 'utf8');
    const plan = planEmitForSource(source, proposals, {file});
    plan.absolutePath = absolutePath;
    plans.push(plan);
  }
  return plans;
}

function writeEmit(plans: Array<FilePlan>): Array<string> {
  const written: Array<string> = [];
  for (let i = 0; i < plans.length; i++) {
    const plan = plans[i];
    if (
      plan.error != null ||
      plan.absolutePath == null ||
      plan.after === plan.before
    ) {
      continue;
    }
    fs.writeFileSync(plan.absolutePath, plan.after);
    written.push(plan.file);
  }
  return written;
}

// The accepted proposals from either a ReviewExport or a ProposalsFile.
function loadAccepted(json: any): {
  accepted: Array<ToolProposal>,
  sourceDir: string | null,
} {
  if (json == null || typeof json !== 'object') {
    throw new Error('expected a ReviewExport or ProposalsFile JSON object');
  }
  if (Array.isArray(json.accepted)) {
    const review: ReviewExport = json;
    return {accepted: review.accepted, sourceDir: null};
  }
  if (Array.isArray(json.proposals)) {
    const file: ProposalsFile = json;
    return {
      accepted: file.proposals.filter(
        proposal => proposal.status === 'accepted',
      ),
      sourceDir:
        file.source != null && typeof file.source.dir === 'string'
          ? file.source.dir
          : null,
    };
  }
  throw new Error(
    'expected a ReviewExport (with "accepted") or a ProposalsFile (with "proposals")',
  );
}

/** Diff */

function diffOps(before: Array<string>, after: Array<string>): Array<DiffOp> {
  let prefix = 0;
  const maxPrefix = Math.min(before.length, after.length);
  while (prefix < maxPrefix && before[prefix] === after[prefix]) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < maxPrefix - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix++;
  }
  const a = before.slice(prefix, before.length - suffix);
  const b = after.slice(prefix, after.length - suffix);
  // Longest common subsequence over the changed middle.
  const table: Array<Array<number>> = [];
  for (let i = 0; i <= a.length; i++) {
    const row: Array<number> = [];
    for (let j = 0; j <= b.length; j++) {
      row.push(0);
    }
    table.push(row);
  }
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] =
        a[i] === b[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const ops: Array<DiffOp> = [];
  for (let i = 0; i < prefix; i++) {
    ops.push({type: ' ', text: before[i]});
  }
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      ops.push({type: ' ', text: a[i]});
      i++;
      j++;
    } else if (
      j < b.length &&
      (i >= a.length || table[i][j + 1] >= table[i + 1][j])
    ) {
      ops.push({type: '+', text: b[j]});
      j++;
    } else {
      ops.push({type: '-', text: a[i]});
      i++;
    }
  }
  for (let k = before.length - suffix; k < before.length; k++) {
    ops.push({type: ' ', text: before[k]});
  }
  return ops;
}

function unifiedDiff(file: string, before: string, after: string): string {
  if (before === after) {
    return '';
  }
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  if (/\n$/.test(before) && /\n$/.test(after)) {
    beforeLines.pop();
    afterLines.pop();
  }
  const ops = diffOps(beforeLines, afterLines);
  const positioned: Array<{op: DiffOp, oldLine: number, newLine: number}> = [];
  let oldLine = 1;
  let newLine = 1;
  for (let k = 0; k < ops.length; k++) {
    const op = ops[k];
    positioned.push({op, oldLine, newLine});
    if (op.type !== '+') {
      oldLine++;
    }
    if (op.type !== '-') {
      newLine++;
    }
  }
  const output = [`--- a/${file}`, `+++ b/${file}`];
  let k = 0;
  while (k < positioned.length) {
    if (positioned[k].op.type === ' ') {
      k++;
      continue;
    }
    const start = Math.max(0, k - DIFF_CONTEXT);
    let j = k;
    while (j < positioned.length) {
      while (j < positioned.length && positioned[j].op.type !== ' ') {
        j++;
      }
      let run = 0;
      while (
        j + run < positioned.length &&
        positioned[j + run].op.type === ' '
      ) {
        run++;
      }
      if (j + run < positioned.length && run <= 2 * DIFF_CONTEXT) {
        j += run;
        continue;
      }
      break;
    }
    const end = Math.min(positioned.length, j + DIFF_CONTEXT);
    const hunk = positioned.slice(start, end);
    let oldCount = 0;
    let newCount = 0;
    for (let h = 0; h < hunk.length; h++) {
      if (hunk[h].op.type !== '+') {
        oldCount++;
      }
      if (hunk[h].op.type !== '-') {
        newCount++;
      }
    }
    const oldStart = oldCount === 0 ? hunk[0].oldLine - 1 : hunk[0].oldLine;
    const newStart = newCount === 0 ? hunk[0].newLine - 1 : hunk[0].newLine;
    output.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (let h = 0; h < hunk.length; h++) {
      output.push(`${hunk[h].op.type}${hunk[h].op.text}`);
    }
    k = end;
  }
  return output.join('\n') + '\n';
}

module.exports = {
  MARKER,
  hookBlock,
  loadAccepted,
  planEmit,
  planEmitForSource,
  unifiedDiff,
  writeEmit,
};
