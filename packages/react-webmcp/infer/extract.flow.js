/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

'use strict';

// `infer extract`: a static pass over an app's React components that proposes
// agent tools from what the code already does. It never publishes anything; it
// writes `ToolProposal` records for a human to review.
//
// Candidates, per component (a function whose name starts with a capital
// letter and that renders JSX or calls hooks):
//
//   1. Existing tools: `useWebMCPTool({...})` calls and `<Tool>` elements are
//      reported with `status: 'exported'` so the review overlay can show what
//      is already implemented next to what is proposed.
//   2. Handlers: functions inside the component that set state, fetch,
//      navigate, call a prop such as `addItem`, or are wired to an event prop.
//   3. Forms: `<form onSubmit>` whose named inputs become the input schema.
//
// The output is deterministic for unchanged source: ids are derived from the
// file, component and handler, never hashed or counted.

import type {
  ProposalBinding,
  ProposalEvidence,
  ProposalInputSchema,
  ProposalSchemaProperty,
  ProposalStatus,
  ProposalsFile,
  ToolProposal,
} from '../src/ReactWebMCPProposalTypes';
import type {Safety} from 'shared/ReactWebMCPTypes';

const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;

const {
  getJSXAttribute,
  getObjectProperty,
  isToolElement,
  isUseWebMCPToolCall,
  propertyKeyName,
  readExecute,
  resolveExpression,
  stringValue,
} = require('../validate/staticCheck');

type Node = any;
type NodePath = any;
type RouteFrom = 'path' | 'scope' | 'component';
type ParamStyle = 'positional' | 'object' | 'none';

type ExtractOptions = {
  // The file's path relative to the directory extract was pointed at.
  file: string,
  routeFrom?: RouteFrom,
  // ISO timestamp recorded as `inferredAt`; defaults to now.
  now?: string,
};

type ExtractDirectoryOptions = {
  routeFrom?: RouteFrom,
  now?: string,
  onWarning?: (message: string) => void,
};

type ParamInfo = {
  name: string,
  type: string,
  description: string,
  required: boolean,
  // Set when a form input had no `name` and the property was named after
  // another attribute instead ('id', 'aria-label', 'label', 'placeholder').
  derivedFrom?: string,
};

type Wiring = {prop: string, element: string};

type HandlerAnalysis = {
  setterCalls: Array<string>,
  effectCalls: Array<string>,
  propCalls: Array<PropCall>,
  localCalls: Array<string>,
  // The single call a one-line handler consists of, when it is one.
  singleCall: Node | null,
};

type PropCall = {
  name: string,
  text: string,
  args: Array<Node>,
};

type Component = {
  name: string,
  path: NodePath,
  node: Node,
  setters: Set<string>,
  named: Array<NamedHandler>,
  inline: Array<InlineHandler>,
  forms: Array<FormCandidate>,
  existing: Array<ExistingTool>,
  wiring: Map<string, Array<Wiring>>,
  headings: Array<{start: number, text: string}>,
  // Named handlers consumed by a <form onSubmit>.
  consumed: Set<string>,
};

type NamedHandler = {
  name: string,
  fnPath: NodePath,
  node: Node,
};

type InlineHandler = {
  fnPath: NodePath,
  prop: string,
  elementPath: NodePath,
};

type FormCandidate = {
  elementPath: NodePath,
  handlerName: string | null,
  fnPath: NodePath | null,
};

type ExistingTool = {
  kind: 'existing-hook' | 'existing-tool-element',
  path: NodePath,
  node: Node,
  name: string,
  description: string,
  safety: Safety,
  schema: ProposalInputSchema | null,
  schemaIsLiteral: boolean,
  execute: any,
};

type Candidate = {
  kind: 'handler' | 'form',
  component: Component,
  name: string,
  handler: string | null,
  params: Array<ParamInfo>,
  paramStyle: ParamStyle,
  line: number,
  column: number,
  // The callee comes from props and is not defined in this file.
  calleeFromProps: string | null,
  // The function node the candidate ultimately calls, for dedupe.
  resolvedCallee: Node | null,
  isInline: boolean,
  formHandler: string | null,
  // The state setter when the handler only flips a boolean (UI state).
  uiOnly: string | null,
};

const SOURCE_EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx'];
const EVENT_PROPS = ['onClick', 'onSubmit', 'onChange', 'onInput', 'onToggle'];
const EVENT_PARAM_NAMES = ['e', 'event', 'evt'];
const EVENT_WORDS = ['click', 'submit', 'change', 'input', 'toggle'];
const EFFECT_CALLEES = ['dispatch', 'fetch', 'navigate', 'mutate'];
const ROUTER_OBJECTS = ['router', 'history'];
const FUNCTION_WRAPPERS = ['useCallback', 'memo', 'forwardRef'];
const ROUTE_DIRS = ['pages', 'routes', 'app', 'views', 'screens'];
const PROP_VERB =
  /^(on[A-Z]|add|remove|delete|clear|create|update|save|submit|toggle|set)/;
const SETTER_NAME = /^set[A-Z]/;
const UI_LOCAL_STATE =
  /^(set)?(draft|open|hover|focus|show|visible|expanded|loading|modal)/i;
const READ_VERBS = /^(get|list|search|find|read|fetch|load|show|view|count)$/;
const IRREVERSIBLE_VERBS =
  /^(delete|remove|clear|purchase|pay|place|send|publish|destroy|reset|cancel|checkout)$/;
// Objects that make an otherwise ordinary verb consequential (submit_order).
const CONSEQUENTIAL_WORDS =
  /^(order|orders|payment|payments|pay|purchase|checkout|charge|refund|transfer|delete|destroy|cancel|publish|send)$/;
const NUMERIC_PARAM =
  /^(quantity|qty|count|amount|price|total|index|page|limit|size|id)$|(Quantity|Qty|Count|Amount|Price|Total|Index|Limit|Size|Id)$/;
const BOOLEAN_PARAM =
  /^(is|has|can|should)[A-Z_]|^(enabled|disabled|checked|open|visible|selected|active)$/;

/** Strings */

function splitWords(name: string): Array<string> {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(word => word !== '')
    .map(word => word.toLowerCase());
}

function snakeCase(name: string): string {
  return splitWords(name).join('_');
}

function kebabCase(name: string): string {
  return splitWords(name).join('-');
}

function humanize(name: string): string {
  const text = name.split('_').join(' ').trim();
  return text === '' ? '' : text.charAt(0).toUpperCase() + text.slice(1);
}

function safetyFromName(name: string): Safety {
  const words = name.split('_');
  let verb = words[0];
  if (EVENT_WORDS.indexOf(verb) !== -1 && words.length > 2) {
    verb = words[1];
  }
  if (READ_VERBS.test(verb)) {
    return 'read';
  }
  if (IRREVERSIBLE_VERBS.test(verb)) {
    return 'irreversible';
  }
  for (let i = 1; i < words.length; i++) {
    if (CONSEQUENTIAL_WORDS.test(words[i])) {
      return 'irreversible';
    }
  }
  return 'mutate';
}

function inferType(paramName: string): string {
  if (NUMERIC_PARAM.test(paramName)) {
    return 'number';
  }
  if (BOOLEAN_PARAM.test(paramName)) {
    return 'boolean';
  }
  return 'string';
}

function describeFromName(name: string, params: Array<ParamInfo>): string {
  let description = humanize(name) + '.';
  if (params.length > 0) {
    description += ` Takes ${params.map(param => param.name).join(', ')}.`;
  }
  return description;
}

function toPosix(file: string): string {
  return file.split(path.sep).join('/');
}

/** Parsing */

function parserPluginsFor(file: string): Array<string> {
  const extension = path.extname(file).toLowerCase();
  if (extension === '.ts') {
    return ['typescript'];
  }
  if (extension === '.tsx') {
    return ['jsx', 'typescript'];
  }
  return ['jsx', 'flow'];
}

function parseSource(source: string, file: string): Node {
  return parser.parse(source, {
    sourceType: 'module',
    plugins: parserPluginsFor(file),
    errorRecovery: true,
    allowReturnOutsideFunction: true,
  });
}

/** AST helpers */

function isFunctionNode(node: Node): boolean {
  return (
    node != null &&
    (node.type === 'ArrowFunctionExpression' ||
      node.type === 'FunctionExpression' ||
      node.type === 'FunctionDeclaration')
  );
}

function jsxElementName(openingElement: Node): string | null {
  const name = openingElement.name;
  if (name.type === 'JSXIdentifier') {
    return name.name;
  }
  if (name.type === 'JSXMemberExpression') {
    return name.property.name;
  }
  return null;
}

function hasJSXAttribute(openingElement: Node, attributeName: string): boolean {
  const attributes = openingElement.attributes;
  for (let i = 0; i < attributes.length; i++) {
    const attribute = attributes[i];
    if (
      attribute.type === 'JSXAttribute' &&
      attribute.name.type === 'JSXIdentifier' &&
      attribute.name.name === attributeName
    ) {
      return (
        attribute.value == null || stringValue(attribute.value) !== 'false'
      );
    }
  }
  return false;
}

function jsxAttributeString(
  openingElement: Node,
  attributeName: string,
): string | null {
  return stringValue(getJSXAttribute(openingElement, attributeName));
}

// The literal text directly inside an element ("Reload inventory").
function directText(element: Node): string | null {
  const children = element.children || [];
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    let text = null;
    if (child.type === 'JSXText') {
      text = child.value;
    } else if (child.type === 'JSXExpressionContainer') {
      text = stringValue(child.expression);
    }
    if (text != null) {
      const trimmed = text.replace(/\s+/g, ' ').trim();
      if (trimmed !== '') {
        return trimmed;
      }
    }
  }
  return null;
}

function elementLabel(element: Node): string | null {
  const opening = element.openingElement;
  const text = directText(element);
  if (text != null) {
    return text;
  }
  const attributes = ['aria-label', 'name', 'value', 'data-testid', 'id'];
  for (let i = 0; i < attributes.length; i++) {
    const value = jsxAttributeString(opening, attributes[i]);
    if (value != null && value.trim() !== '') {
      return value.trim();
    }
  }
  return null;
}

function stripParentheticals(text: string): string {
  return text
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// useCallback(fn, deps), memo(fn), forwardRef(fn): calls whose first argument
// is the function the variable really names. (Not useState(() => …) or
// useMemo(() => …), whose argument is an initializer, not the value.)
function isFunctionWrapperCall(node: Node): boolean {
  if (node == null || node.type !== 'CallExpression') {
    return false;
  }
  const callee = node.callee;
  let name = null;
  if (callee.type === 'Identifier') {
    name = callee.name;
  } else if (
    callee.type === 'MemberExpression' &&
    !callee.computed &&
    callee.property.type === 'Identifier'
  ) {
    name = callee.property.name;
  }
  return (
    name != null &&
    FUNCTION_WRAPPERS.indexOf(name) !== -1 &&
    node.arguments.length > 0 &&
    isFunctionNode(node.arguments[0])
  );
}

function unwrapFunction(node: Node): Node | null {
  if (node == null) {
    return null;
  }
  if (isFunctionNode(node)) {
    return node;
  }
  if (isFunctionWrapperCall(node)) {
    return node.arguments[0];
  }
  return null;
}

function functionPathOfDeclarator(declaratorPath: NodePath): NodePath | null {
  const init = declaratorPath.node.init;
  if (init == null) {
    return null;
  }
  if (isFunctionNode(init)) {
    return declaratorPath.get('init');
  }
  if (isFunctionWrapperCall(init)) {
    return declaratorPath.get('init.arguments.0');
  }
  return null;
}

// Name of a function from its declaration or the variable it is assigned to.
function functionName(fnPath: NodePath): string | null {
  const node = fnPath.node;
  if (node.id != null && node.id.type === 'Identifier') {
    return node.id.name;
  }
  let parent = fnPath.parentPath;
  if (
    parent != null &&
    parent.isCallExpression() &&
    parent.node.arguments[0] === node
  ) {
    parent = parent.parentPath;
  }
  if (
    parent != null &&
    parent.isVariableDeclarator() &&
    parent.node.id.type === 'Identifier'
  ) {
    return parent.node.id.name;
  }
  return null;
}

function isHookCallee(callee: Node): boolean {
  if (callee.type === 'Identifier') {
    return /^use[A-Z]/.test(callee.name);
  }
  return (
    callee.type === 'MemberExpression' &&
    !callee.computed &&
    callee.property.type === 'Identifier' &&
    /^use[A-Z]/.test(callee.property.name)
  );
}

function usesJSXOrHooks(fnPath: NodePath): boolean {
  let found = false;
  fnPath.traverse({
    JSXElement(nodePath: NodePath) {
      found = true;
      nodePath.stop();
    },
    JSXFragment(nodePath: NodePath) {
      found = true;
      nodePath.stop();
    },
    CallExpression(nodePath: NodePath) {
      if (isHookCallee(nodePath.node.callee)) {
        found = true;
        nodePath.stop();
      }
    },
  });
  return found;
}

function isStateHookCallee(callee: Node): boolean {
  const names = ['useState', 'useReducer'];
  if (callee.type === 'Identifier') {
    return names.indexOf(callee.name) !== -1;
  }
  return (
    callee.type === 'MemberExpression' &&
    !callee.computed &&
    callee.property.type === 'Identifier' &&
    names.indexOf(callee.property.name) !== -1
  );
}

function typeAnnotationMentionsEvent(annotation: mixed): boolean {
  if (annotation == null || typeof annotation !== 'object') {
    return false;
  }
  if (Array.isArray(annotation)) {
    return annotation.some(typeAnnotationMentionsEvent);
  }
  const node: {[string]: mixed} = annotation as any;
  const nodeType = node.type;
  const nodeName = node.name;
  if (
    (nodeType === 'Identifier' || nodeType === 'JSXIdentifier') &&
    typeof nodeName === 'string' &&
    /Event/.test(nodeName)
  ) {
    return true;
  }
  const keys = Object.keys(node);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (key === 'loc' || key === 'range' || key === 'leadingComments') {
      continue;
    }
    const value = node[key];
    if (
      value != null &&
      typeof value === 'object' &&
      typeAnnotationMentionsEvent(value)
    ) {
      return true;
    }
  }
  return false;
}

function isEventParam(param: Node): boolean {
  const target = param.type === 'AssignmentPattern' ? param.left : param;
  if (target.type !== 'Identifier') {
    return false;
  }
  if (EVENT_PARAM_NAMES.indexOf(target.name) !== -1) {
    return true;
  }
  return typeAnnotationMentionsEvent(target.typeAnnotation);
}

// Reads a function's parameters into schema-ready descriptions.
function readParams(fn: Node): {params: Array<ParamInfo>, style: ParamStyle} {
  const params: Array<ParamInfo> = [];
  const fnParams = (fn.params || []).filter(param => !isEventParam(param));
  if (fnParams.length === 0) {
    return {params, style: 'none'};
  }
  let first = fnParams[0];
  let firstHasDefault = false;
  if (first.type === 'AssignmentPattern') {
    firstHasDefault = true;
    first = first.left;
  }
  if (first.type === 'ObjectPattern') {
    const properties = first.properties;
    for (let i = 0; i < properties.length; i++) {
      const property = properties[i];
      if (property.type === 'RestElement') {
        continue;
      }
      const name = propertyKeyName(property);
      if (name == null) {
        continue;
      }
      params.push({
        name,
        type: inferType(name),
        description: '',
        required:
          !firstHasDefault && property.value.type !== 'AssignmentPattern',
      });
    }
    return {params, style: 'object'};
  }
  for (let i = 0; i < fnParams.length; i++) {
    let param = fnParams[i];
    let required = true;
    if (param.type === 'AssignmentPattern') {
      required = false;
      param = param.left;
    }
    if (param.type === 'RestElement') {
      continue;
    }
    if (param.type !== 'Identifier') {
      params.push({
        name: `arg${i + 1}`,
        type: 'string',
        description: '',
        required,
      });
      continue;
    }
    params.push({
      name: param.name,
      type: inferType(param.name),
      description: '',
      required,
    });
  }
  return {params, style: 'positional'};
}

function schemaFromParams(
  params: Array<ParamInfo>,
): ProposalInputSchema | null {
  if (params.length === 0) {
    return null;
  }
  const properties: {[string]: ProposalSchemaProperty} = {};
  const required: Array<string> = [];
  for (let i = 0; i < params.length; i++) {
    const param = params[i];
    properties[param.name] = {type: param.type, description: param.description};
    if (param.required) {
      required.push(param.name);
    }
  }
  return {type: 'object', properties, required};
}

// Reads a literal inputSchema object into the proposal shape, or null when it
// is not a literal we can read.
function readSchemaLiteral(
  schemaNode: Node,
  nodePath: NodePath,
): ProposalInputSchema | null {
  const schema = resolveExpression(schemaNode, nodePath);
  if (schema == null || schema.type !== 'ObjectExpression') {
    return null;
  }
  const properties: {[string]: ProposalSchemaProperty} = {};
  const propertiesProperty = getObjectProperty(schema, 'properties');
  if (propertiesProperty != null) {
    const value = resolveExpression(propertiesProperty.value, nodePath);
    if (value == null || value.type !== 'ObjectExpression') {
      return null;
    }
    const entries = value.properties;
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const name = propertyKeyName(entry);
      if (name == null || entry.type !== 'ObjectProperty') {
        return null;
      }
      const definition = resolveExpression(entry.value, nodePath);
      let type = 'string';
      let description = '';
      if (definition != null && definition.type === 'ObjectExpression') {
        const typeProperty = getObjectProperty(definition, 'type');
        const typeText =
          typeProperty == null ? null : stringValue(typeProperty.value);
        if (typeText != null) {
          type = typeText;
        }
        const descriptionProperty = getObjectProperty(
          definition,
          'description',
        );
        const descriptionText =
          descriptionProperty == null
            ? null
            : stringValue(descriptionProperty.value);
        if (descriptionText != null) {
          description = descriptionText;
        }
      }
      properties[name] = {type, description};
    }
  }
  const required: Array<string> = [];
  const requiredProperty = getObjectProperty(schema, 'required');
  if (requiredProperty != null) {
    const value = resolveExpression(requiredProperty.value, nodePath);
    if (value == null || value.type !== 'ArrayExpression') {
      return null;
    }
    for (let i = 0; i < value.elements.length; i++) {
      const name = stringValue(value.elements[i]);
      if (name == null) {
        return null;
      }
      required.push(name);
    }
  }
  return {type: 'object', properties, required};
}

function readSafety(value: string | null): Safety {
  if (value === 'read') {
    return 'read';
  }
  if (value === 'irreversible') {
    return 'irreversible';
  }
  return 'mutate';
}

function lineOf(node: Node): number {
  return node.loc != null ? node.loc.start.line : 0;
}

// 1-based, as editors show it.
function columnOf(node: Node): number {
  return node.loc != null ? node.loc.start.column + 1 : 0;
}

/** Component discovery */

type FileIndex = {
  file: string,
  components: Map<Node, Component>,
  componentsByName: Map<string, Component>,
  // JSX usages of capitalized elements, by name, in source order.
  usages: Map<string, Array<NodePath>>,
  // Any function bound to a name anywhere in the file, for prop callees.
  functionsByName: Map<string, Array<Node>>,
};

function enclosingComponent(
  nodePath: NodePath,
  index: FileIndex,
): Component | null {
  let current = nodePath.getFunctionParent();
  while (current != null) {
    const component = index.components.get(current.node);
    if (component !== undefined) {
      return component;
    }
    current = current.getFunctionParent();
  }
  return null;
}

function createComponent(name: string, fnPath: NodePath): Component {
  return {
    name,
    path: fnPath,
    node: fnPath.node,
    setters: new Set(),
    named: [],
    inline: [],
    forms: [],
    existing: [],
    wiring: new Map(),
    headings: [],
    consumed: new Set(),
  };
}

function indexFile(ast: Node, file: string): FileIndex {
  const index: FileIndex = {
    file,
    components: new Map(),
    componentsByName: new Map(),
    usages: new Map(),
    functionsByName: new Map(),
  };
  traverse(ast, {
    'FunctionDeclaration|FunctionExpression|ArrowFunctionExpression'(
      fnPath: NodePath,
    ) {
      const name = functionName(fnPath);
      if (name == null) {
        return;
      }
      const list: Array<Node> = index.functionsByName.get(name) || [];
      list.push(fnPath.node);
      index.functionsByName.set(name, list);
      if (!/^[A-Z]/.test(name) || !usesJSXOrHooks(fnPath)) {
        return;
      }
      const component = createComponent(name, fnPath);
      index.components.set(fnPath.node, component);
      if (!index.componentsByName.has(name)) {
        index.componentsByName.set(name, component);
      }
    },
    JSXElement(elementPath: NodePath) {
      const name = jsxElementName(elementPath.node.openingElement);
      if (name == null || !/^[A-Z]/.test(name)) {
        return;
      }
      const list: Array<NodePath> = index.usages.get(name) || [];
      list.push(elementPath);
      index.usages.set(name, list);
    },
  });
  return index;
}

/** Scope paths */

function isScopeElement(openingElement: Node): boolean {
  const name = jsxElementName(openingElement);
  return (
    name === 'ToolScope' ||
    name === 'Scope' ||
    name === 'WebMCPScope' ||
    name === 'unstable_WebMCPScope'
  );
}

// <ToolScope name="…"> / <Scope name="…"> ancestors of a node, outermost first.
function lexicalScopePath(nodePath: NodePath): Array<string> {
  const names: Array<string> = [];
  let current = nodePath.parentPath;
  while (current != null) {
    if (current.isJSXElement()) {
      const opening = current.node.openingElement;
      if (isScopeElement(opening)) {
        const name = jsxAttributeString(opening, 'name');
        if (name != null) {
          names.unshift(name);
        }
      }
    }
    current = current.parentPath;
  }
  return names;
}

// The scopes a component renders under, following its first JSX usage in the
// same file (static only; empty when the component is not used in the file).
function componentScopePath(
  componentName: string,
  index: FileIndex,
  cache: Map<string, Array<string>>,
  visiting: Set<string>,
): Array<string> {
  const cached = cache.get(componentName);
  if (cached !== undefined) {
    return cached;
  }
  if (visiting.has(componentName)) {
    return [];
  }
  visiting.add(componentName);
  let result: Array<string> = [];
  const usages = index.usages.get(componentName);
  if (usages !== undefined && usages.length > 0) {
    const usage = usages[0];
    const lexical = lexicalScopePath(usage);
    const renderer = enclosingComponent(usage, index);
    const inherited =
      renderer == null
        ? []
        : componentScopePath(renderer.name, index, cache, visiting);
    result = inherited.concat(lexical);
  }
  visiting.delete(componentName);
  cache.set(componentName, result);
  return result;
}

/** Collection */

function collect(ast: Node, index: FileIndex): void {
  traverse(ast, {
    VariableDeclarator(declaratorPath: NodePath) {
      const component = enclosingComponent(declaratorPath, index);
      if (component == null) {
        return;
      }
      const node = declaratorPath.node;
      if (
        node.id.type === 'ArrayPattern' &&
        node.init != null &&
        node.init.type === 'CallExpression' &&
        isStateHookCallee(node.init.callee)
      ) {
        const setter = node.id.elements[1];
        if (setter != null && setter.type === 'Identifier') {
          component.setters.add(setter.name);
        }
        return;
      }
      if (node.id.type !== 'Identifier') {
        return;
      }
      const fnPath = functionPathOfDeclarator(declaratorPath);
      if (fnPath == null || index.components.has(fnPath.node)) {
        return;
      }
      const functionParent = declaratorPath.getFunctionParent();
      if (functionParent == null || functionParent.node !== component.node) {
        return;
      }
      component.named.push({name: node.id.name, fnPath, node: fnPath.node});
    },
    FunctionDeclaration(fnPath: NodePath) {
      if (index.components.has(fnPath.node) || fnPath.node.id == null) {
        return;
      }
      const component = enclosingComponent(fnPath, index);
      if (component == null) {
        return;
      }
      const functionParent = fnPath.getFunctionParent();
      if (functionParent == null || functionParent.node !== component.node) {
        return;
      }
      component.named.push({
        name: fnPath.node.id.name,
        fnPath,
        node: fnPath.node,
      });
    },
    JSXAttribute(attributePath: NodePath) {
      const attribute = attributePath.node;
      if (
        attribute.name.type !== 'JSXIdentifier' ||
        EVENT_PROPS.indexOf(attribute.name.name) === -1
      ) {
        return;
      }
      const component = enclosingComponent(attributePath, index);
      if (component == null) {
        return;
      }
      const prop = attribute.name.name;
      const openingPath = attributePath.parentPath;
      const elementPath = openingPath.parentPath;
      const element = jsxElementName(openingPath.node) || '';
      const value = attribute.value;
      if (value == null || value.type !== 'JSXExpressionContainer') {
        return;
      }
      const expression = value.expression;
      if (prop === 'onSubmit' && element === 'form') {
        if (expression.type === 'Identifier') {
          component.forms.push({
            elementPath,
            handlerName: expression.name,
            fnPath: null,
          });
          component.consumed.add(expression.name);
        } else if (isFunctionNode(expression)) {
          component.forms.push({
            elementPath,
            handlerName: null,
            fnPath: attributePath.get('value.expression'),
          });
        }
        return;
      }
      if (expression.type === 'Identifier') {
        const list: Array<Wiring> = component.wiring.get(expression.name) || [];
        list.push({prop, element});
        component.wiring.set(expression.name, list);
        return;
      }
      if (isFunctionNode(expression)) {
        component.inline.push({
          fnPath: attributePath.get('value.expression'),
          prop,
          elementPath,
        });
      }
    },
    JSXElement(elementPath: NodePath) {
      const opening = elementPath.node.openingElement;
      const name = jsxElementName(opening);
      const component = enclosingComponent(elementPath, index);
      if (component == null) {
        return;
      }
      if (name != null && /^h[1-6]$/.test(name)) {
        const text = directText(elementPath.node);
        if (text != null) {
          component.headings.push({start: elementPath.node.start, text});
        }
        return;
      }
      if (!isToolElement(opening)) {
        return;
      }
      const toolName = jsxAttributeString(opening, 'name');
      if (toolName == null) {
        return;
      }
      const schemaAttribute = getJSXAttribute(opening, 'inputSchema');
      const executeAttribute = getJSXAttribute(opening, 'execute');
      const toolSchema =
        schemaAttribute == null
          ? null
          : readSchemaLiteral(schemaAttribute, elementPath);
      component.existing.push({
        kind: 'existing-tool-element',
        path: elementPath,
        node: opening,
        name: toolName,
        description: jsxAttributeString(opening, 'description') || '',
        safety: readSafety(jsxAttributeString(opening, 'safety')),
        schema: toolSchema,
        schemaIsLiteral: schemaAttribute == null || toolSchema != null,
        execute:
          executeAttribute == null
            ? null
            : readExecute(executeAttribute, elementPath),
      });
    },
    CallExpression(callPath: NodePath) {
      const node = callPath.node;
      if (!isUseWebMCPToolCall(node) || node.arguments.length === 0) {
        return;
      }
      const component = enclosingComponent(callPath, index);
      if (component == null) {
        return;
      }
      const options = resolveExpression(node.arguments[0], callPath);
      if (options == null || options.type !== 'ObjectExpression') {
        return;
      }
      const nameProperty = getObjectProperty(options, 'name');
      const toolName =
        nameProperty == null ? null : stringValue(nameProperty.value);
      if (toolName == null) {
        return;
      }
      const descriptionProperty = getObjectProperty(options, 'description');
      const safetyProperty = getObjectProperty(options, 'safety');
      const schemaProperty = getObjectProperty(options, 'inputSchema');
      const executeProperty = getObjectProperty(options, 'execute');
      const schema =
        schemaProperty == null
          ? null
          : readSchemaLiteral(schemaProperty.value, callPath);
      component.existing.push({
        kind: 'existing-hook',
        path: callPath,
        node,
        name: toolName,
        description:
          descriptionProperty == null
            ? ''
            : stringValue(descriptionProperty.value) || '',
        safety: readSafety(
          safetyProperty == null ? null : stringValue(safetyProperty.value),
        ),
        schema,
        schemaIsLiteral: schemaProperty == null || schema != null,
        execute:
          executeProperty == null
            ? null
            : readExecute(
                executeProperty.type === 'ObjectMethod'
                  ? executeProperty
                  : executeProperty.value,
                callPath,
              ),
      });
    },
  });
}

/** Handler analysis */

function isTrivialEventCall(statement: Node): boolean {
  if (
    statement.type !== 'ExpressionStatement' ||
    statement.expression.type !== 'CallExpression'
  ) {
    return false;
  }
  const callee = statement.expression.callee;
  return (
    callee.type === 'MemberExpression' &&
    !callee.computed &&
    callee.property.type === 'Identifier' &&
    (callee.property.name === 'preventDefault' ||
      callee.property.name === 'stopPropagation')
  );
}

function singleCallOf(fn: Node): Node | null {
  let body = fn.body;
  if (body.type === 'AwaitExpression') {
    body = body.argument;
  }
  if (body.type === 'CallExpression') {
    return body;
  }
  if (body.type !== 'BlockStatement') {
    return null;
  }
  const statements = body.body.filter(
    statement => !isTrivialEventCall(statement),
  );
  if (statements.length !== 1) {
    return null;
  }
  const statement = statements[0];
  let expression = null;
  if (statement.type === 'ExpressionStatement') {
    expression = statement.expression;
  } else if (statement.type === 'ReturnStatement') {
    expression = statement.argument;
  }
  if (expression != null && expression.type === 'AwaitExpression') {
    expression = expression.argument;
  }
  return expression != null && expression.type === 'CallExpression'
    ? expression
    : null;
}

function isPropBinding(binding: any, component: Component): boolean {
  return (
    binding != null &&
    binding.kind === 'param' &&
    binding.scope === component.path.scope
  );
}

function isLocalFunctionBinding(binding: any, component: Component): boolean {
  if (binding == null || binding.scope !== component.path.scope) {
    return false;
  }
  if (binding.path.isFunctionDeclaration()) {
    return true;
  }
  return (
    binding.path.isVariableDeclarator() &&
    binding.path.node.id.type === 'Identifier' &&
    unwrapFunction(binding.path.node.init) != null
  );
}

function analyzeHandler(
  fnPath: NodePath,
  component: Component,
): HandlerAnalysis {
  const analysis: HandlerAnalysis = {
    setterCalls: [],
    effectCalls: [],
    propCalls: [],
    localCalls: [],
    singleCall: singleCallOf(fnPath.node),
  };
  const visitCall = (callPath: NodePath) => {
    const call = callPath.node;
    const callee = call.callee;
    if (callee.type === 'Identifier') {
      const name = callee.name;
      const binding = callPath.scope.getBinding(name);
      if (component.setters.has(name) || SETTER_NAME.test(name)) {
        analysis.setterCalls.push(name);
      } else if (EFFECT_CALLEES.indexOf(name) !== -1) {
        analysis.effectCalls.push(name);
      } else if (isPropBinding(binding, component) && PROP_VERB.test(name)) {
        analysis.propCalls.push({name, text: name, args: call.arguments});
      } else if (isLocalFunctionBinding(binding, component)) {
        analysis.localCalls.push(name);
      }
      return;
    }
    if (
      callee.type === 'MemberExpression' &&
      !callee.computed &&
      callee.property.type === 'Identifier' &&
      callee.object.type === 'Identifier'
    ) {
      const objectName = callee.object.name;
      const propertyName = callee.property.name;
      if (
        ROUTER_OBJECTS.indexOf(objectName) !== -1 &&
        (propertyName === 'push' || propertyName === 'replace')
      ) {
        analysis.effectCalls.push(`${objectName}.${propertyName}`);
        return;
      }
      const binding = callPath.scope.getBinding(objectName);
      if (isPropBinding(binding, component) && PROP_VERB.test(propertyName)) {
        analysis.propCalls.push({
          name: propertyName,
          text: `${objectName}.${propertyName}`,
          args: call.arguments,
        });
      }
    }
  };
  // `traverse` visits every descendant, including an expression body.
  fnPath.traverse({CallExpression: visitCall});
  return analysis;
}

// setX(event.target.value) / setX(event.target.checked) one-liners.
function isInputPlumbing(fn: Node, analysis: HandlerAnalysis): boolean {
  const call = analysis.singleCall;
  if (call == null || call.callee.type !== 'Identifier') {
    return false;
  }
  if (!SETTER_NAME.test(call.callee.name) || call.arguments.length !== 1) {
    return false;
  }
  const argument = call.arguments[0];
  if (
    argument.type !== 'MemberExpression' ||
    argument.computed ||
    argument.property.type !== 'Identifier' ||
    (argument.property.name !== 'value' && argument.property.name !== 'checked')
  ) {
    return false;
  }
  const target = argument.object;
  if (
    target.type !== 'MemberExpression' ||
    target.computed ||
    target.property.type !== 'Identifier' ||
    (target.property.name !== 'target' &&
      target.property.name !== 'currentTarget')
  ) {
    return false;
  }
  const params = fn.params;
  return (
    target.object.type === 'Identifier' &&
    params.length > 0 &&
    params[0].type === 'Identifier' &&
    params[0].name === target.object.name
  );
}

function isUILocalOnly(
  analysis: HandlerAnalysis,
  qualifyingLocalCalls: boolean,
): boolean {
  if (
    analysis.effectCalls.length > 0 ||
    analysis.propCalls.length > 0 ||
    qualifyingLocalCalls ||
    analysis.setterCalls.length === 0
  ) {
    return false;
  }
  return analysis.setterCalls.every(name => UI_LOCAL_STATE.test(name));
}

// setOpen(true), setOpen(!open), setOpen(value => !value): a handler that only
// flips a flag. Returns the setter's name, or null.
function uiOnlySetter(analysis: HandlerAnalysis): string | null {
  const call = analysis.singleCall;
  if (
    call == null ||
    call.callee.type !== 'Identifier' ||
    !SETTER_NAME.test(call.callee.name) ||
    call.arguments.length !== 1 ||
    analysis.effectCalls.length > 0 ||
    analysis.propCalls.length > 0
  ) {
    return null;
  }
  const setter = call.callee.name;
  let argument = call.arguments[0];
  if (
    argument.type === 'ArrowFunctionExpression' ||
    argument.type === 'FunctionExpression'
  ) {
    let body = argument.body;
    if (body.type === 'BlockStatement') {
      if (
        body.body.length !== 1 ||
        body.body[0].type !== 'ReturnStatement' ||
        body.body[0].argument == null
      ) {
        return null;
      }
      body = body.body[0].argument;
    }
    argument = body;
  }
  if (argument.type === 'BooleanLiteral') {
    return setter;
  }
  if (argument.type === 'UnaryExpression' && argument.operator === '!') {
    return setter;
  }
  return null;
}

function isOnlyInputChangeWiring(wiring: Array<Wiring>): boolean {
  return wiring.every(
    entry =>
      entry.prop === 'onChange' &&
      (entry.element === 'input' ||
        entry.element === 'select' ||
        entry.element === 'textarea'),
  );
}

// Finds the function a prop callee refers to, by following the JSX that passes
// it in (`<Inventory addItem={addItem} />`) or, failing that, any function
// with that name in the file.
function resolvePropCallee(
  calleeName: string,
  component: Component,
  index: FileIndex,
): Node | null {
  const usages: Array<NodePath> = index.usages.get(component.name) || [];
  for (let i = 0; i < usages.length; i++) {
    const usage = usages[i];
    const attribute = getJSXAttribute(usage.node.openingElement, calleeName);
    if (attribute == null) {
      continue;
    }
    const resolved = resolveExpression(attribute, usage);
    const fn = unwrapFunction(resolved);
    if (fn != null) {
      return fn;
    }
  }
  const byName = index.functionsByName.get(calleeName);
  return byName !== undefined && byName.length > 0 ? byName[0] : null;
}

/** Candidates */

function makeHandlerCandidate(
  component: Component,
  name: string,
  handler: string | null,
  fn: Node,
  params: Array<ParamInfo>,
  paramStyle: ParamStyle,
  isInline: boolean,
): Candidate {
  return {
    kind: 'handler',
    component,
    name,
    handler,
    params,
    paramStyle,
    line: lineOf(fn),
    column: columnOf(fn),
    calleeFromProps: null,
    resolvedCallee: null,
    isInline,
    formHandler: null,
    uiOnly: null,
  };
}

function qualifiesByName(
  name: string,
  component: Component,
  analyses: Map<string, HandlerAnalysis>,
  seen: Set<string>,
): boolean {
  if (seen.has(name)) {
    return false;
  }
  seen.add(name);
  const analysis = analyses.get(name);
  if (analysis === undefined) {
    return false;
  }
  if (
    analysis.setterCalls.length > 0 ||
    analysis.effectCalls.length > 0 ||
    analysis.propCalls.length > 0
  ) {
    return true;
  }
  const wiring = component.wiring.get(name);
  if (wiring !== undefined && wiring.length > 0) {
    return true;
  }
  return analysis.localCalls.some(local =>
    qualifiesByName(local, component, analyses, seen),
  );
}

function componentCandidates(
  component: Component,
  index: FileIndex,
): Array<Candidate> {
  const candidates: Array<Candidate> = [];
  const analyses: Map<string, HandlerAnalysis> = new Map();
  const namedByNode: Map<Node, NamedHandler> = new Map();
  for (let i = 0; i < component.named.length; i++) {
    const named = component.named[i];
    analyses.set(named.name, analyzeHandler(named.fnPath, component));
    namedByNode.set(named.node, named);
  }

  // Named handlers.
  for (let i = 0; i < component.named.length; i++) {
    const named = component.named[i];
    if (component.consumed.has(named.name)) {
      continue;
    }
    const analysis = analyses.get(named.name);
    if (analysis === undefined) {
      continue;
    }
    const wiring: Array<Wiring> = component.wiring.get(named.name) || [];
    const localQualifies = analysis.localCalls.some(local => {
      const seen: Set<string> = new Set([named.name]);
      return qualifiesByName(local, component, analyses, seen);
    });
    const qualifies =
      analysis.setterCalls.length > 0 ||
      analysis.effectCalls.length > 0 ||
      analysis.propCalls.length > 0 ||
      localQualifies ||
      wiring.length > 0;
    if (!qualifies) {
      continue;
    }
    if (
      isUILocalOnly(analysis, localQualifies) &&
      (wiring.length === 0 || isOnlyInputChangeWiring(wiring))
    ) {
      continue;
    }
    const {params, style} = readParams(named.node);
    const candidate = makeHandlerCandidate(
      component,
      snakeCase(named.name),
      named.name,
      named.node,
      params,
      style,
      false,
    );
    candidate.uiOnly = uiOnlySetter(analysis);
    candidates.push(candidate);
  }

  // Inline handlers on event props.
  for (let i = 0; i < component.inline.length; i++) {
    const inline = component.inline[i];
    const fn = inline.fnPath.node;
    const analysis = analyzeHandler(inline.fnPath, component);
    if (isInputPlumbing(fn, analysis)) {
      continue;
    }
    const localQualifies = analysis.localCalls.some(local => {
      const seen: Set<string> = new Set();
      return qualifiesByName(local, component, analyses, seen);
    });
    const wiring: Array<Wiring> = [
      {
        prop: inline.prop,
        element: jsxElementName(inline.elementPath.node.openingElement) || '',
      },
    ];
    if (
      isUILocalOnly(analysis, localQualifies) &&
      isOnlyInputChangeWiring(wiring)
    ) {
      continue;
    }
    const call = analysis.singleCall;
    if (call != null && call.callee.type === 'Identifier') {
      const binding = inline.fnPath.scope.getBinding(call.callee.name);
      if (isLocalFunctionBinding(binding, component)) {
        // `onClick={() => clearCart()}`: the named handler is the proposal.
        continue;
      }
    }
    if (
      call != null &&
      analysis.propCalls.length === 1 &&
      analysis.setterCalls.length === 0 &&
      analysis.effectCalls.length === 0 &&
      !/^on[A-Z]/.test(analysis.propCalls[0].name)
    ) {
      // The handler only forwards to a prop: the proposal belongs to it.
      const propCall = analysis.propCalls[0];
      const resolved = resolvePropCallee(propCall.name, component, index);
      const params: Array<ParamInfo> = [];
      let style: ParamStyle =
        propCall.args.length === 0 ? 'none' : 'positional';
      if (resolved != null) {
        const calleeParams = readParams(resolved);
        if (calleeParams.style === 'object' && propCall.args.length === 1) {
          style = 'object';
          for (let j = 0; j < calleeParams.params.length; j++) {
            params.push(calleeParams.params[j]);
          }
        } else {
          for (let j = 0; j < propCall.args.length; j++) {
            const known = calleeParams.params[j];
            params.push(
              known !== undefined
                ? known
                : {
                    name: `arg${j + 1}`,
                    type: 'string',
                    description: '',
                    required: true,
                  },
            );
          }
        }
      } else {
        for (let j = 0; j < propCall.args.length; j++) {
          params.push({
            name: `arg${j + 1}`,
            type: 'string',
            description: '',
            required: true,
          });
        }
      }
      const candidate = makeHandlerCandidate(
        component,
        snakeCase(propCall.name),
        propCall.text,
        fn,
        params,
        style,
        true,
      );
      candidate.resolvedCallee = resolved;
      candidate.calleeFromProps = resolved == null ? propCall.text : null;
      candidates.push(candidate);
      continue;
    }
    const label = elementLabel(inline.elementPath.node);
    const eventWord = inline.prop.slice(2).toLowerCase();
    const suffix = label == null ? `L${lineOf(fn)}` : snakeCase(label);
    const inlineCandidate = makeHandlerCandidate(
      component,
      `${eventWord}_${suffix}`,
      null,
      fn,
      [],
      'none',
      true,
    );
    inlineCandidate.uiOnly = uiOnlySetter(analysis);
    candidates.push(inlineCandidate);
  }

  // Forms.
  for (let i = 0; i < component.forms.length; i++) {
    const form = component.forms[i];
    const candidate = formCandidate(form, component, namedByNode);
    if (candidate != null) {
      candidates.push(candidate);
    }
  }

  return candidates;
}

function formInputs(formPath: NodePath): Array<ParamInfo> {
  const inputs: Array<ParamInfo> = [];
  const labelsFor: Map<string, string> = new Map();
  formPath.traverse({
    JSXElement(elementPath: NodePath) {
      const opening = elementPath.node.openingElement;
      if (jsxElementName(opening) !== 'label') {
        return;
      }
      const htmlFor = jsxAttributeString(opening, 'htmlFor');
      const text = directText(elementPath.node);
      if (htmlFor != null && text != null) {
        labelsFor.set(htmlFor, text);
      }
    },
  });
  formPath.traverse({
    JSXElement(elementPath: NodePath) {
      const opening = elementPath.node.openingElement;
      const element = jsxElementName(opening);
      if (
        element !== 'input' &&
        element !== 'select' &&
        element !== 'textarea'
      ) {
        return;
      }
      // Label text for this input, through htmlFor/id or an enclosing <label>.
      let labelText: string | null = null;
      const inputId = jsxAttributeString(opening, 'id');
      if (inputId != null && labelsFor.has(inputId)) {
        labelText = labelsFor.get(inputId) || null;
      }
      if (labelText == null) {
        const enclosingLabel = elementPath.findParent(
          parent =>
            parent.isJSXElement() &&
            jsxElementName(parent.node.openingElement) === 'label',
        );
        if (enclosingLabel != null) {
          labelText = directText(enclosingLabel.node);
        }
      }
      let name = jsxAttributeString(opening, 'name');
      let derivedFrom: string | null = null;
      if (name == null || name === '') {
        // No name: fall back to what the page shows for the field, and say so
        // in the evidence so the reviewer renames it or names the input.
        const fallbacks: Array<[string, string | null]> = [
          ['id', inputId],
          ['aria-label', jsxAttributeString(opening, 'aria-label')],
          ['label', labelText],
          ['placeholder', jsxAttributeString(opening, 'placeholder')],
        ];
        for (let i = 0; i < fallbacks.length && name == null; i++) {
          const value = fallbacks[i][1];
          if (value != null && value.trim() !== '') {
            name = snakeCase(stripParentheticals(value));
            derivedFrom = fallbacks[i][0];
          }
        }
        if (name == null || name === '') {
          return;
        }
      }
      const inputType = (
        jsxAttributeString(opening, 'type') || ''
      ).toLowerCase();
      let type = 'string';
      if (inputType === 'number' || inputType === 'range') {
        type = 'number';
      } else if (inputType === 'checkbox') {
        type = 'boolean';
      }
      const description =
        jsxAttributeString(opening, 'placeholder') ||
        jsxAttributeString(opening, 'aria-label') ||
        labelText ||
        '';
      const input: ParamInfo = {
        name,
        type,
        description,
        required: hasJSXAttribute(opening, 'required'),
      };
      if (derivedFrom != null) {
        input.derivedFrom = derivedFrom;
      }
      inputs.push(input);
    },
  });
  return inputs;
}

function nearestHeading(component: Component, before: number): string | null {
  let best = null;
  for (let i = 0; i < component.headings.length; i++) {
    const heading = component.headings[i];
    if (
      heading.start < before &&
      (best == null || heading.start > best.start)
    ) {
      best = heading;
    }
  }
  return best == null ? null : best.text;
}

function formCandidate(
  form: FormCandidate,
  component: Component,
  namedByNode: Map<Node, NamedHandler>,
): Candidate | null {
  const element = form.elementPath.node;
  const opening = element.openingElement;
  let handlerFn = form.fnPath == null ? null : form.fnPath.node;
  if (form.handlerName != null) {
    const named = component.named.find(
      entry => entry.name === form.handlerName,
    );
    handlerFn = named === undefined ? null : named.node;
  }
  let purpose =
    jsxAttributeString(opening, 'aria-label') ||
    jsxAttributeString(opening, 'name') ||
    jsxAttributeString(opening, 'id') ||
    null;
  if (purpose == null) {
    const heading = nearestHeading(component, element.start);
    purpose = heading == null ? null : stripParentheticals(heading);
  }
  if (purpose == null || purpose === '') {
    purpose = component.name;
  }
  let params = formInputs(form.elementPath);
  let style: ParamStyle = 'object';
  if (params.length === 0) {
    if (handlerFn != null) {
      const fromHandler = readParams(handlerFn);
      params = fromHandler.params;
      style = fromHandler.style;
    } else {
      style = 'none';
    }
  }
  return {
    kind: 'form',
    component,
    name: `submit_${snakeCase(purpose)}`,
    handler: form.handlerName,
    params,
    paramStyle: style,
    line: lineOf(opening),
    column: columnOf(opening),
    calleeFromProps: null,
    resolvedCallee: null,
    isInline: form.handlerName == null,
    formHandler: form.handlerName,
    uiOnly: null,
  };
}

/** Proposals */

function routeFromPath(file: string): string | null {
  const segments = toPosix(file).split('/');
  for (let i = 0; i < segments.length - 1; i++) {
    if (ROUTE_DIRS.indexOf(segments[i]) === -1) {
      continue;
    }
    const rest = segments
      .slice(i + 1)
      .filter(segment => !/^\(.*\)$/.test(segment));
    const parts: Array<string> = [];
    for (let j = 0; j < rest.length; j++) {
      let segment = rest[j];
      if (j === rest.length - 1) {
        segment = segment.replace(/\.[^.]+$/, '');
      }
      if (/^(index|page|route|layout)$/.test(segment)) {
        continue;
      }
      segment = segment
        .replace(/^\[\.\.\.(.+)\]$/, '*')
        .replace(/^\[(.+)\]$/, ':$1');
      parts.push(segment);
    }
    return '/' + parts.slice(0, 1).join('/');
  }
  return null;
}

function routeFor(
  file: string,
  component: string | null,
  scopePath: Array<string>,
  routeFrom: RouteFrom,
): string {
  if (routeFrom === 'scope') {
    return scopePath.length === 0 ? '/' : '/' + scopePath.join('/');
  }
  if (routeFrom === 'component') {
    return component == null ? '/' : '/' + kebabCase(component);
  }
  const fromPath = routeFromPath(file);
  if (fromPath != null) {
    return fromPath;
  }
  return component == null ? '/' : '/' + kebabCase(component);
}

function pendingEvidence(): Array<ProposalEvidence> {
  return [
    {check: 'replay', level: 'pending', summary: 'not traced yet'},
    {check: 'trace', level: 'pending', summary: 'no journey recorded'},
  ];
}

function existingSchemaEvidence(tool: ExistingTool): Array<ProposalEvidence> {
  if (!tool.schemaIsLiteral) {
    return [
      {
        check: 'schema',
        level: 'pending',
        summary: 'inputSchema is not a literal object; cannot compare',
      },
    ];
  }
  if (tool.execute == null) {
    return [
      {
        check: 'schema',
        level: 'pending',
        summary: 'execute is not a function literal; cannot compare',
      },
    ];
  }
  if (tool.execute.whole) {
    return [
      {
        check: 'schema',
        level: 'ok',
        summary: 'execute reads the whole input object',
      },
    ];
  }
  const declared: Array<string> =
    tool.schema == null ? [] : Object.keys(tool.schema.properties);
  const used: Array<string> = tool.execute.params;
  const rows: Array<ProposalEvidence> = [];
  for (let i = 0; i < declared.length; i++) {
    if (used.indexOf(declared[i]) === -1) {
      rows.push({
        check: 'schema',
        level: 'warn',
        property: declared[i],
        summary: `${declared[i]} is never read`,
      });
    }
  }
  if (!tool.execute.hasRest) {
    for (let i = 0; i < used.length; i++) {
      if (declared.indexOf(used[i]) === -1) {
        rows.push({
          check: 'schema',
          level: 'warn',
          property: used[i],
          summary: `${used[i]} is read but not declared`,
        });
      }
    }
  }
  if (rows.length === 0) {
    rows.push({
      check: 'schema',
      level: 'ok',
      summary: 'schema matches handler parameters',
    });
  }
  return rows;
}

function existingProposal(
  tool: ExistingTool,
  component: Component,
  index: FileIndex,
  scopeCache: Map<string, Array<string>>,
  options: {file: string, routeFrom: RouteFrom, now: string},
): ToolProposal {
  const file = options.file;
  const visiting: Set<string> = new Set();
  const scopePath = componentScopePath(
    component.name,
    index,
    scopeCache,
    visiting,
  ).concat(lexicalScopePath(tool.path));
  const line = lineOf(tool.node);
  const column = columnOf(tool.node);
  let params: Array<string> = [];
  let paramStyle: ParamStyle = 'none';
  if (tool.execute != null) {
    if (tool.execute.whole) {
      paramStyle = 'object';
    } else if (tool.execute.params.length > 0) {
      params = tool.execute.params;
      paramStyle = 'object';
    }
  }
  const binding: ProposalBinding = {
    kind: tool.kind,
    file,
    line,
    column,
    component: component.name,
    handler: null,
    params,
    paramStyle,
  };
  const evidence: Array<ProposalEvidence> = [
    {
      check: 'binding',
      level: 'ok',
      summary: `already implemented at ${file}:${line}`,
      location: {file, line, column},
    },
    ...existingSchemaEvidence(tool),
    ...pendingEvidence(),
  ];
  return {
    id: `${file}#${component.name}.${tool.name}`,
    name: tool.name,
    qualifiedName: scopePath.concat(tool.name).join('_'),
    scopePath,
    route: routeFor(file, component.name, scopePath, options.routeFrom),
    description: tool.description,
    safety: tool.safety,
    lifetime: 'view',
    inputSchema: tool.schema,
    binding,
    evidence,
    status: 'exported',
    inferredAt: options.now,
    provider: null,
  };
}

function candidateProposal(
  candidate: Candidate,
  index: FileIndex,
  scopeCache: Map<string, Array<string>>,
  options: {file: string, routeFrom: RouteFrom, now: string},
): ToolProposal {
  const file = options.file;
  const component = candidate.component;
  const visiting: Set<string> = new Set();
  const scopePath = componentScopePath(
    component.name,
    index,
    scopeCache,
    visiting,
  );
  const line = candidate.line;
  const column = candidate.column;
  const location = {file, line, column};
  const binding: ProposalBinding = {
    kind: candidate.kind,
    file,
    line,
    column,
    component: component.name,
    handler: candidate.handler,
    params: candidate.params.map(param => param.name),
    paramStyle: candidate.paramStyle,
  };
  const subject =
    candidate.kind === 'form'
      ? 'form onSubmit'
      : candidate.handler != null
        ? candidate.handler
        : 'inline handler';
  const bindingEvidence: ProposalEvidence =
    candidate.calleeFromProps != null
      ? {
          check: 'binding',
          level: 'warn',
          summary: `${candidate.calleeFromProps} comes from props; defined elsewhere`,
          location,
        }
      : {
          check: 'binding',
          level: 'ok',
          summary: `binding ${subject} exists`,
          location,
        };
  const evidence: Array<ProposalEvidence> = [bindingEvidence];
  const derivedParams = candidate.params.filter(
    param => param.derivedFrom != null,
  );
  if (derivedParams.length > 0) {
    for (let i = 0; i < derivedParams.length; i++) {
      const param = derivedParams[i];
      evidence.push({
        check: 'schema',
        level: 'warn',
        property: param.name,
        summary: `"${param.name}" is named after the input's ${
          param.derivedFrom != null ? param.derivedFrom : 'text'
        }; give the input a name`,
      });
    }
  } else {
    evidence.push({
      check: 'schema',
      level: 'ok',
      summary:
        candidate.kind === 'form'
          ? 'schema derived from the form inputs'
          : 'schema derived from handler parameters',
    });
  }
  if (candidate.uiOnly != null) {
    evidence.push({
      check: 'intent',
      level: 'warn',
      summary: `only toggles ${candidate.uiOnly}; looks like UI state, not an action an agent needs`,
    });
  }
  const pending = pendingEvidence();
  for (let i = 0; i < pending.length; i++) {
    evidence.push(pending[i]);
  }
  const handlerPart =
    candidate.handler != null ? candidate.handler : `L${line}`;
  const status: ProposalStatus = 'proposed';
  return {
    id: `${file}#${component.name}.${handlerPart}`,
    name: candidate.name,
    qualifiedName: scopePath.concat(candidate.name).join('_'),
    scopePath,
    route: routeFor(file, component.name, scopePath, options.routeFrom),
    description: describeFromName(candidate.name, candidate.params),
    safety: safetyFromName(candidate.name),
    lifetime: 'view',
    inputSchema: schemaFromParams(candidate.params),
    binding,
    evidence,
    status,
    inferredAt: options.now,
    provider: null,
  };
}

function compareProposals(a: ToolProposal, b: ToolProposal): number {
  if (a.binding.file !== b.binding.file) {
    return a.binding.file < b.binding.file ? -1 : 1;
  }
  if (a.binding.line !== b.binding.line) {
    return a.binding.line - b.binding.line;
  }
  if (a.binding.column !== b.binding.column) {
    return a.binding.column - b.binding.column;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function extractFromSource(
  source: string,
  options: ExtractOptions,
): Array<ToolProposal> {
  const file = toPosix(options.file);
  const routeFrom: RouteFrom =
    options.routeFrom == null ? 'path' : options.routeFrom;
  const now = options.now == null ? new Date().toISOString() : options.now;
  const ast = parseSource(source, file);
  const index = indexFile(ast, file);
  collect(ast, index);
  const scopeCache: Map<string, Array<string>> = new Map();
  const proposalOptions = {file, routeFrom, now};

  const existing: Array<ToolProposal> = [];
  const candidates: Array<Candidate> = [];
  index.components.forEach(component => {
    for (let i = 0; i < component.existing.length; i++) {
      existing.push(
        existingProposal(
          component.existing[i],
          component,
          index,
          scopeCache,
          proposalOptions,
        ),
      );
    }
    const found = componentCandidates(component, index);
    for (let i = 0; i < found.length; i++) {
      candidates.push(found[i]);
    }
  });

  // Dedupe: an inline handler that forwards to a named handler anywhere in
  // the file is only UI wiring for it.
  const namedHandlerNodes: Set<Node> = new Set();
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    if (!candidate.isInline && candidate.kind === 'handler') {
      index.components.forEach(component => {
        for (let j = 0; j < component.named.length; j++) {
          if (component.named[j].name === candidate.handler) {
            namedHandlerNodes.add(component.named[j].node);
          }
        }
      });
    }
  }
  const proposals: Array<ToolProposal> = existing.slice();
  const existingQualifiedNames: Set<string> = new Set(
    existing.map(proposal => proposal.qualifiedName),
  );
  const seenIds: Set<string> = new Set(existing.map(proposal => proposal.id));
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    if (
      candidate.resolvedCallee != null &&
      namedHandlerNodes.has(candidate.resolvedCallee)
    ) {
      continue;
    }
    const proposal = candidateProposal(
      candidate,
      index,
      scopeCache,
      proposalOptions,
    );
    if (existingQualifiedNames.has(proposal.qualifiedName)) {
      continue;
    }
    if (seenIds.has(proposal.id)) {
      continue;
    }
    seenIds.add(proposal.id);
    proposals.push(proposal);
  }

  // Existing tools that collide inside one file are worth a warning.
  const byQualifiedName: Map<string, ToolProposal> = new Map();
  for (let i = 0; i < existing.length; i++) {
    const proposal = existing[i];
    const first = byQualifiedName.get(proposal.qualifiedName);
    if (first === undefined) {
      byQualifiedName.set(proposal.qualifiedName, proposal);
      continue;
    }
    proposal.evidence[0] = {
      check: 'binding',
      level: 'warn',
      summary: `collides with ${first.qualifiedName} in ${
        first.binding.component || '-'
      } (same file)`,
      location: proposal.evidence[0].location,
    };
  }

  proposals.sort(compareProposals);
  return proposals;
}

/** Directories */

function isSkippedName(name: string, isDirectory: boolean): boolean {
  if (name.charAt(0) === '.') {
    return true;
  }
  if (isDirectory) {
    return name === 'node_modules' || name === '__tests__';
  }
  if (/\.d\.ts$/.test(name)) {
    return true;
  }
  if (/(\.test|-test|\.spec|-spec)\.[^.]+$/.test(name)) {
    return true;
  }
  return SOURCE_EXTENSIONS.indexOf(path.extname(name).toLowerCase()) === -1;
}

function listSourceFiles(dir: string): Array<string> {
  const files: Array<string> = [];
  const walk = (current: string, prefix: string) => {
    const entries = fs.readdirSync(current).slice().sort();
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const full = path.join(current, entry);
      const isDirectory = fs.statSync(full).isDirectory();
      if (isSkippedName(entry, isDirectory)) {
        continue;
      }
      const relative = prefix === '' ? entry : `${prefix}/${entry}`;
      if (isDirectory) {
        walk(full, relative);
      } else {
        files.push(relative);
      }
    }
  };
  walk(dir, '');
  return files.sort();
}

function describeSourceDir(dir: string): string {
  const absolute = path.resolve(dir);
  const relative = path.relative(process.cwd(), absolute);
  if (relative === '') {
    return '.';
  }
  if (relative.indexOf('..') === 0 || path.isAbsolute(relative)) {
    return toPosix(absolute);
  }
  return toPosix(relative);
}

function extractFromDirectory(
  dir: string,
  options: ExtractDirectoryOptions,
): ProposalsFile {
  const absolute = path.resolve(dir);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isDirectory()) {
    throw new Error(`${dir} is not a directory`);
  }
  const now = options.now == null ? new Date().toISOString() : options.now;
  const files = listSourceFiles(absolute);
  let proposals: Array<ToolProposal> = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const source = fs.readFileSync(path.join(absolute, file), 'utf8');
    try {
      proposals = proposals.concat(
        extractFromSource(source, {file, routeFrom: options.routeFrom, now}),
      );
    } catch (error) {
      if (options.onWarning != null) {
        options.onWarning(`could not analyze ${file}: ${error.message}`);
      }
    }
  }
  proposals.sort(compareProposals);
  return {
    version: 1,
    generatedAt: now,
    source: {dir: describeSourceDir(dir), files},
    proposals,
  };
}

module.exports = {
  extractFromDirectory,
  extractFromSource,
  functionName,
  humanize,
  kebabCase,
  listSourceFiles,
  parseSource,
  parserPluginsFor,
  safetyFromName,
  snakeCase,
};
