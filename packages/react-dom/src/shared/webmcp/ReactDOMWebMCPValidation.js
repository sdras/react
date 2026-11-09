/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {ToolRecord, ToolSource} from 'shared/ReactWebMCPTypes';

import hasOwnProperty from 'shared/hasOwnProperty';

// Budgets from Chrome's WebMCP guidance. Exceeding them does not break
// registration, but agents may truncate or ignore oversized definitions.
export const MAX_NAME_LENGTH = 30;
export const MAX_DESCRIPTION_LENGTH = 500;
export const MAX_PARAM_DESCRIPTION_LENGTH = 150;

// The characters agent clients accept in a tool name. MCP clients allow
// letters, digits, underscores and hyphens and nothing else in common, so a
// name outside this set may be rejected before the agent ever sees the tool.
// Scope names are prefixed with underscores (see resolveQualifiedName), so
// the agent-facing name is checked as a whole. Length is budgeted above.
const VALID_NAME = /^[a-zA-Z0-9_-]+$/;

export type ValidationRule =
  | 'duplicate-name'
  | 'missing-name'
  | 'invalid-name'
  | 'name-length'
  | 'qualified-name-length'
  | 'missing-description'
  | 'description-length'
  | 'required-not-declared'
  | 'param-description-length'
  | 'missing-safety'
  | 'duplicate-key'
  | 'missing-execute';

// What logIssue needs to print a message. The text itself lives there, one
// literal per rule, so the warning list extracted from the source has it.
export type ValidationIssue = {
  rule: ValidationRule,
  // Which API declared the tool. The advice differs between the hook in
  // react-dom and the tool tree in react-webmcp.
  source: ToolSource,
  // The agent-facing name of the tool.
  qualifiedName: string,
  // The schema property the rule is about, or null when it has none.
  detail: null | string,
};

function createIssue(
  record: ToolRecord,
  rule: ValidationRule,
  detail: null | string,
): ValidationIssue {
  return {
    rule,
    source: record.source,
    qualifiedName: record.qualifiedName,
    detail,
  };
}

// Structural checks on a tool definition. These run in DEV only and are
// reported once per tool and rule.
export function validateToolRecord(
  record: ToolRecord,
  existing: Map<string, ToolRecord>,
): Array<ValidationIssue> {
  const issues: Array<ValidationIssue> = [];

  let hasDuplicate = false;
  existing.forEach(other => {
    if (
      !hasDuplicate &&
      other.key !== record.key &&
      other.qualifiedName === record.qualifiedName
    ) {
      hasDuplicate = true;
    }
  });
  if (hasDuplicate) {
    issues.push(createIssue(record, 'duplicate-name', null));
  }

  if (typeof record.name !== 'string' || record.name === '') {
    issues.push(createIssue(record, 'missing-name', null));
  } else {
    if (!VALID_NAME.test(record.qualifiedName)) {
      issues.push(createIssue(record, 'invalid-name', null));
    }
    if (record.name.length > MAX_NAME_LENGTH) {
      issues.push(createIssue(record, 'name-length', null));
    } else if (record.qualifiedName.length > MAX_NAME_LENGTH) {
      issues.push(createIssue(record, 'qualified-name-length', null));
    }
  }

  if (typeof record.description !== 'string' || record.description === '') {
    issues.push(createIssue(record, 'missing-description', null));
  } else if (record.description.length > MAX_DESCRIPTION_LENGTH) {
    issues.push(createIssue(record, 'description-length', null));
  }

  const schema: any = record.inputSchema;
  if (schema != null && typeof schema === 'object') {
    const properties =
      schema.properties != null && typeof schema.properties === 'object'
        ? schema.properties
        : null;
    if (Array.isArray(schema.required)) {
      for (let i = 0; i < schema.required.length; i++) {
        const required = schema.required[i];
        if (properties === null || !hasOwnProperty.call(properties, required)) {
          issues.push(
            createIssue(
              record,
              'required-not-declared',
              // eslint-disable-next-line react-internal/safe-string-coercion
              String(required),
            ),
          );
        }
      }
    }
    if (properties !== null) {
      for (const propertyName in properties) {
        const property = properties[propertyName];
        if (
          property != null &&
          typeof property.description === 'string' &&
          property.description.length > MAX_PARAM_DESCRIPTION_LENGTH
        ) {
          issues.push(
            createIssue(record, 'param-description-length', propertyName),
          );
        }
      }
    }
  }

  if (record.safety === null) {
    issues.push(createIssue(record, 'missing-safety', null));
  }

  return issues;
}

// Two mounted components hold records under one registry key: the same
// qualified name without distinct keys. Developer tooling shows one of them,
// so the other disappears from it.
export function validateKeyCollision(record: ToolRecord): ValidationIssue {
  return createIssue(record, 'duplicate-key', null);
}

// Only the hook validates `execute` here; the tool tree in react-webmcp
// checks its props before it writes a record.
export function validateExecute(
  qualifiedName: string,
  execute: mixed,
): null | ValidationIssue {
  if (typeof execute === 'function') {
    return null;
  }
  return {
    rule: 'missing-execute',
    source: 'hook',
    qualifiedName,
    detail: null,
  };
}

// The message for each rule. Structural problems agents reject are errors;
// exceeded budgets are warnings.
export function logIssue(issue: ValidationIssue): void {
  if (__DEV__) {
    const name = issue.qualifiedName;
    switch (issue.rule) {
      case 'duplicate-name': {
        if (issue.source === 'tree') {
          console.error(
            'Two WebMCP tools are registered with the name "%s". Agents ' +
              'cannot tell them apart. Give them distinct names, or wrap one ' +
              'in <Scope name> to prefix it.',
            name,
          );
        } else {
          console.error(
            'Two WebMCP tools are registered with the name "%s". Agents ' +
              'cannot tell them apart. Give them distinct names, or wrap one ' +
              'in <ReactDOM.unstable_WebMCPScope name> to prefix it.',
            name,
          );
        }
        break;
      }
      case 'missing-name': {
        console.error(
          'Expected the `name` of a WebMCP tool to be a non-empty string.',
        );
        break;
      }
      case 'invalid-name': {
        console.error(
          'The WebMCP tool name "%s" contains characters other than letters, ' +
            'digits, underscores and hyphens, which agents may reject. Use ' +
            'only those in tool and scope names, like "add_item".',
          name,
        );
        break;
      }
      case 'name-length': {
        console.warn(
          'The WebMCP tool name "%s" is longer than %s characters. Prefer ' +
            'short, action-oriented names like "add_item".',
          name,
          MAX_NAME_LENGTH,
        );
        break;
      }
      case 'qualified-name-length': {
        console.warn(
          'The scoped WebMCP tool name "%s" is longer than %s characters. ' +
            'Use shorter scope names.',
          name,
          MAX_NAME_LENGTH,
        );
        break;
      }
      case 'missing-description': {
        console.error(
          'The WebMCP tool "%s" has no description. Agents pick tools by ' +
            'their descriptions; say what the tool does and when to use it.',
          name,
        );
        break;
      }
      case 'description-length': {
        console.warn(
          'The description of the WebMCP tool "%s" is longer than %s ' +
            'characters. Agents may truncate it.',
          name,
          MAX_DESCRIPTION_LENGTH,
        );
        break;
      }
      case 'required-not-declared': {
        console.error(
          'The inputSchema of the WebMCP tool "%s" marks "%s" as required ' +
            'but does not declare it in `properties`.',
          name,
          issue.detail,
        );
        break;
      }
      case 'param-description-length': {
        console.warn(
          'The description of parameter "%s" on the WebMCP tool "%s" is ' +
            'longer than %s characters.',
          issue.detail,
          name,
          MAX_PARAM_DESCRIPTION_LENGTH,
        );
        break;
      }
      case 'missing-safety': {
        console.warn(
          'The WebMCP tool "%s" does not declare `safety`. Agents assume a ' +
            'tool mutates state unless it is marked "read", and ask the user ' +
            'before running one marked "irreversible".',
          name,
        );
        break;
      }
      case 'duplicate-key': {
        if (issue.source === 'tree') {
          console.error(
            'Two components registered a WebMCP tool named "%s" without ' +
              'distinct keys. Agents cannot tell them apart, and developer ' +
              'tooling only keeps the most recent one. Give them distinct ' +
              'names, wrap one in <Scope name> to prefix it, or set a unique ' +
              '`id` on each <Tool>.',
            name,
          );
        } else {
          console.error(
            'Two components registered a WebMCP tool named "%s" without ' +
              'distinct keys. Agents cannot tell them apart, and developer ' +
              'tooling only keeps the most recent one. Give them distinct ' +
              'names, wrap one in <ReactDOM.unstable_WebMCPScope name> to ' +
              'prefix it, or pass a unique `key` option to each ' +
              'ReactDOM.unstable_useWebMCPTool call.',
            name,
          );
        }
        break;
      }
      case 'missing-execute': {
        console.error(
          'The WebMCP tool "%s" has no `execute` function. It will not be ' +
            'registered.',
          name,
        );
        break;
      }
    }
  }
}

const reported: Set<string> = new Set();

// Reports each issue once per tool key and rule. Collisions between owners are
// deduplicated by the registry per pair of owners instead, since the same key
// can collide again with a different component after the first is fixed.
export function reportIssues(key: string, issues: Array<ValidationIssue>) {
  if (__DEV__) {
    for (let i = 0; i < issues.length; i++) {
      const issue = issues[i];
      const dedupeKey = key + '\n' + issue.rule;
      if (reported.has(dedupeKey)) {
        continue;
      }
      reported.add(dedupeKey);
      logIssue(issue);
    }
  }
}
