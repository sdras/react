/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

'use strict';

// Schema/handler agreement: compares the properties a tool declares in its
// inputSchema with the parameters its `execute` function destructures. Pure
// function over source text, so it can run in CI without a browser and be
// unit-tested directly.

const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;

function parseSource(source) {
  return parser.parse(source, {
    sourceType: 'module',
    plugins: ['jsx', 'flow'],
    errorRecovery: true,
  });
}

function stringValue(node) {
  if (node == null) {
    return null;
  }
  if (node.type === 'StringLiteral') {
    return node.value;
  }
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis.map(quasi => quasi.value.cooked).join('');
  }
  if (node.type === 'JSXExpressionContainer') {
    return stringValue(node.expression);
  }
  return null;
}

function propertyKeyName(property) {
  if (property.computed) {
    return null;
  }
  if (property.key.type === 'Identifier') {
    return property.key.name;
  }
  if (property.key.type === 'StringLiteral') {
    return property.key.value;
  }
  return null;
}

function getObjectProperty(objectExpression, name) {
  if (
    objectExpression == null ||
    objectExpression.type !== 'ObjectExpression'
  ) {
    return null;
  }
  const objectProperties = objectExpression.properties;
  for (let i = 0; i < objectProperties.length; i++) {
    const property = objectProperties[i];
    if (
      (property.type === 'ObjectProperty' ||
        property.type === 'ObjectMethod') &&
      propertyKeyName(property) === name
    ) {
      return property;
    }
  }
  return null;
}

// Follows an identifier to its initializer when it is bound in the same file.
function resolveExpression(node, path) {
  if (node == null) {
    return null;
  }
  if (node.type === 'JSXExpressionContainer') {
    return resolveExpression(node.expression, path);
  }
  if (node.type === 'Identifier') {
    const binding = path.scope.getBinding(node.name);
    if (binding == null) {
      return null;
    }
    if (binding.path.isVariableDeclarator()) {
      return resolveExpression(binding.path.node.init, binding.path);
    }
    if (binding.path.isFunctionDeclaration()) {
      return binding.path.node;
    }
    return null;
  }
  return node;
}

// Returns {properties: Array<string>, required: Array<string>} or null when
// the schema is not a literal we can read.
function readSchema(schemaNode, path) {
  if (schemaNode == null) {
    return {properties: [], required: [], absent: true};
  }
  const schema = resolveExpression(schemaNode, path);
  if (schema == null || schema.type !== 'ObjectExpression') {
    return null;
  }
  const propertiesProperty = getObjectProperty(schema, 'properties');
  const properties = [];
  if (propertiesProperty != null) {
    const value = resolveExpression(propertiesProperty.value, path);
    if (value == null || value.type !== 'ObjectExpression') {
      return null;
    }
    const valueProperties = value.properties;
    for (let i = 0; i < valueProperties.length; i++) {
      const name = propertyKeyName(valueProperties[i]);
      if (name == null) {
        return null;
      }
      properties.push(name);
    }
  }
  const requiredProperty = getObjectProperty(schema, 'required');
  const required = [];
  if (requiredProperty != null) {
    const value = resolveExpression(requiredProperty.value, path);
    if (value == null || value.type !== 'ArrayExpression') {
      return null;
    }
    const elements = value.elements;
    for (let i = 0; i < elements.length; i++) {
      const name = stringValue(elements[i]);
      if (name == null) {
        return null;
      }
      required.push(name);
    }
  }
  return {properties, required, absent: false};
}

// Returns {params: Array<string>, hasRest: boolean} for a destructured first
// parameter, {whole: true} when execute takes the whole input object, {params:
// []} when it takes none, or null when execute cannot be read.
function readExecute(executeNode, path) {
  if (executeNode == null) {
    return null;
  }
  let fn = executeNode;
  if (fn.type !== 'ObjectMethod') {
    fn = resolveExpression(executeNode, path);
  }
  if (fn == null) {
    return null;
  }
  if (
    fn.type !== 'ArrowFunctionExpression' &&
    fn.type !== 'FunctionExpression' &&
    fn.type !== 'FunctionDeclaration' &&
    fn.type !== 'ObjectMethod'
  ) {
    return null;
  }
  if (fn.params.length === 0) {
    return {params: [], hasRest: false, whole: false};
  }
  let first = fn.params[0];
  if (first.type === 'AssignmentPattern') {
    first = first.left;
  }
  if (first.type === 'ObjectPattern') {
    const params = [];
    let hasRest = false;
    const patternProperties = first.properties;
    for (let i = 0; i < patternProperties.length; i++) {
      const property = patternProperties[i];
      if (property.type === 'RestElement') {
        hasRest = true;
        continue;
      }
      const name = propertyKeyName(property);
      if (name == null) {
        return null;
      }
      params.push(name);
    }
    return {params, hasRest, whole: false};
  }
  return {params: [], hasRest: false, whole: true};
}

function difference(a, b) {
  return a.filter(item => b.indexOf(item) === -1);
}

function enclosingComponentName(path) {
  let current = path;
  while (current != null) {
    if (current.isFunctionDeclaration() && current.node.id != null) {
      return current.node.id.name;
    }
    if (
      (current.isArrowFunctionExpression() || current.isFunctionExpression()) &&
      current.parentPath != null &&
      current.parentPath.isVariableDeclarator() &&
      current.parentPath.node.id.type === 'Identifier'
    ) {
      return current.parentPath.node.id.name;
    }
    if (current.isClassDeclaration() && current.node.id != null) {
      return current.node.id.name;
    }
    current = current.parentPath;
  }
  return null;
}

function isUseWebMCPToolCall(node) {
  const callee = node.callee;
  if (callee.type === 'Identifier') {
    return callee.name === 'useWebMCPTool' || callee.name === 'useWebMCP';
  }
  if (callee.type === 'MemberExpression' && !callee.computed) {
    return (
      callee.property.type === 'Identifier' &&
      (callee.property.name === 'useWebMCPTool' ||
        callee.property.name === 'useWebMCP')
    );
  }
  return false;
}

function isToolElement(openingElement) {
  const name = openingElement.name;
  if (name.type === 'JSXIdentifier') {
    return name.name === 'Tool';
  }
  if (name.type === 'JSXMemberExpression') {
    return name.property.name === 'Tool';
  }
  return false;
}

function getJSXAttribute(openingElement, attributeName) {
  const attributes = openingElement.attributes;
  for (let i = 0; i < attributes.length; i++) {
    const attribute = attributes[i];
    if (
      attribute.type === 'JSXAttribute' &&
      attribute.name.type === 'JSXIdentifier' &&
      attribute.name.name === attributeName
    ) {
      return attribute.value;
    }
  }
  return null;
}

// Finds every tool definition (hook call or <Tool> element) in a source file.
function findToolDefinitions(source) {
  const ast = parseSource(source);
  const definitions = [];
  traverse(ast, {
    CallExpression(path) {
      const node = path.node;
      if (!isUseWebMCPToolCall(node) || node.arguments.length === 0) {
        return;
      }
      const options = resolveExpression(node.arguments[0], path);
      if (options == null || options.type !== 'ObjectExpression') {
        return;
      }
      const nameProperty = getObjectProperty(options, 'name');
      const name =
        nameProperty == null ? null : stringValue(nameProperty.value);
      if (name == null) {
        return;
      }
      const schemaProperty = getObjectProperty(options, 'inputSchema');
      const executeProperty = getObjectProperty(options, 'execute');
      definitions.push({
        kind: 'hook',
        name,
        line: node.loc != null ? node.loc.start.line : null,
        component: enclosingComponentName(path),
        schema: readSchema(
          schemaProperty == null ? null : schemaProperty.value,
          path,
        ),
        execute:
          executeProperty == null
            ? null
            : readExecute(
                executeProperty.type === 'ObjectMethod'
                  ? executeProperty
                  : executeProperty.value,
                path,
              ),
      });
    },
    JSXElement(path) {
      const opening = path.node.openingElement;
      if (!isToolElement(opening)) {
        return;
      }
      const name = stringValue(getJSXAttribute(opening, 'name'));
      if (name == null) {
        return;
      }
      const schemaAttribute = getJSXAttribute(opening, 'inputSchema');
      const executeAttribute = getJSXAttribute(opening, 'execute');
      definitions.push({
        kind: 'tree',
        name,
        line: opening.loc != null ? opening.loc.start.line : null,
        component: enclosingComponentName(path),
        schema: readSchema(schemaAttribute, path),
        execute:
          executeAttribute == null ? null : readExecute(executeAttribute, path),
      });
    },
  });
  return definitions;
}

// Compares one tool's declared schema with what its execute function reads.
//
// Returns {status: 'ok' | 'mismatch' | 'skipped' | 'not-found', reason?,
// declared, used, declaredButUnused, usedButUndeclared, requiredButUnused,
// line, component}.
function checkToolAgainstSource(source, {toolName, componentName}) {
  const definitions = findToolDefinitions(source).filter(
    definition => definition.name === toolName,
  );
  if (definitions.length === 0) {
    return {
      status: 'not-found',
      reason:
        'No useWebMCPTool call or <Tool> element named "' +
        toolName +
        '" was found in the source.',
    };
  }
  let definition = definitions[0];
  if (componentName != null) {
    const inComponent = definitions.find(
      candidate => candidate.component === componentName,
    );
    if (inComponent !== undefined) {
      definition = inComponent;
    }
  }
  const base = {
    line: definition.line,
    component: definition.component,
    kind: definition.kind,
  };
  if (definition.schema == null) {
    return {
      ...base,
      status: 'skipped',
      reason: 'inputSchema is not a literal object; cannot compare statically.',
    };
  }
  if (definition.execute == null) {
    return {
      ...base,
      status: 'skipped',
      reason:
        'execute is not a function literal in this file; cannot compare statically.',
    };
  }
  if (definition.execute.whole) {
    return {
      ...base,
      status: 'skipped',
      reason:
        'execute reads its input as a whole object; cannot compare statically.',
    };
  }
  const declared = definition.schema.properties;
  const used = definition.execute.params;
  const declaredButUnused = difference(declared, used);
  const usedButUndeclared = definition.execute.hasRest
    ? []
    : difference(used, declared);
  const requiredButUnused = difference(definition.schema.required, used);
  const mismatch =
    usedButUndeclared.length > 0 ||
    requiredButUnused.length > 0 ||
    (definition.schema.absent && used.length > 0);
  return {
    ...base,
    status: mismatch ? 'mismatch' : 'ok',
    declared,
    used,
    declaredButUnused,
    usedButUndeclared,
    requiredButUnused,
  };
}

module.exports = {
  checkToolAgainstSource,
  findToolDefinitions,
  // Helpers shared with the inference assistant (packages/react-webmcp/infer).
  enclosingComponentName,
  getJSXAttribute,
  getObjectProperty,
  isToolElement,
  isUseWebMCPToolCall,
  propertyKeyName,
  readExecute,
  readSchema,
  resolveExpression,
  stringValue,
};
