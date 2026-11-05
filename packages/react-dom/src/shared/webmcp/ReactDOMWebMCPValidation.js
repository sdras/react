/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {ToolRecord} from 'shared/ReactWebMCPTypes';

import hasOwnProperty from 'shared/hasOwnProperty';

// Budgets from Chrome's WebMCP guidance. Exceeding them does not break
// registration, but agents may truncate or ignore oversized definitions.
export const MAX_NAME_LENGTH = 30;
export const MAX_DESCRIPTION_LENGTH = 500;
export const MAX_PARAM_DESCRIPTION_LENGTH = 150;

export type ValidationLevel = 'error' | 'warn';

export type ValidationIssue = {
  level: ValidationLevel,
  rule: string,
  message: string,
};

// Structural checks on a tool definition. These run in DEV only and are
// reported once per tool and rule.
export function validateToolRecord(
  record: ToolRecord,
  existing: Map<string, ToolRecord>,
): Array<ValidationIssue> {
  const issues: Array<ValidationIssue> = [];
  const label = '"' + record.qualifiedName + '"';

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
    issues.push({
      level: 'error',
      rule: 'duplicate-name',
      message:
        'Two tools are registered with the name ' +
        label +
        '. Agents cannot tell them apart. Give each one a unique `key` and ' +
        'a distinct name, or wrap them in a <ToolScope name> to prefix it.',
    });
  }

  if (record.name.length > MAX_NAME_LENGTH) {
    issues.push({
      level: 'warn',
      rule: 'name-length',
      message:
        'The tool name ' +
        label +
        ' is longer than ' +
        MAX_NAME_LENGTH +
        ' characters. Prefer short, action-oriented names like "add_item".',
    });
  } else if (record.qualifiedName.length > MAX_NAME_LENGTH) {
    issues.push({
      level: 'warn',
      rule: 'qualified-name-length',
      message:
        'The scoped tool name ' +
        label +
        ' is longer than ' +
        MAX_NAME_LENGTH +
        ' characters. Use shorter <ToolScope name> prefixes.',
    });
  }

  if (typeof record.description !== 'string' || record.description === '') {
    issues.push({
      level: 'error',
      rule: 'missing-description',
      message:
        'The tool ' +
        label +
        ' has no description. Agents pick tools by their descriptions; say ' +
        'what the tool does and when to use it.',
    });
  } else if (record.description.length > MAX_DESCRIPTION_LENGTH) {
    issues.push({
      level: 'warn',
      rule: 'description-length',
      message:
        'The description of ' +
        label +
        ' is longer than ' +
        MAX_DESCRIPTION_LENGTH +
        ' characters. Agents may truncate it.',
    });
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
          issues.push({
            level: 'error',
            rule: 'required-not-declared',
            message:
              'The inputSchema of ' +
              label +
              ' marks "' +
              // eslint-disable-next-line react-internal/safe-string-coercion
              String(required) +
              '" as required but does not declare it in `properties`.',
          });
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
          issues.push({
            level: 'warn',
            rule: 'param-description-length',
            message:
              'The description of parameter "' +
              propertyName +
              '" on ' +
              label +
              ' is longer than ' +
              MAX_PARAM_DESCRIPTION_LENGTH +
              ' characters.',
          });
        }
      }
    }
  }

  if (record.safety === null) {
    issues.push({
      level: 'warn',
      rule: 'missing-safety',
      message:
        'The tool ' +
        label +
        ' does not declare `safety`. Agents assume a tool mutates state ' +
        'unless it is marked "read", and ask the user before running one ' +
        'marked "irreversible".',
    });
  }

  return issues;
}

export function validateExecute(
  qualifiedName: string,
  execute: mixed,
): ValidationIssue | null {
  if (typeof execute === 'function') {
    return null;
  }
  return {
    level: 'error',
    rule: 'missing-execute',
    message:
      'The tool "' +
      qualifiedName +
      '" has no `execute` function. It will not be registered.',
  };
}

const reported: Set<string> = new Set();

export function reportIssues(key: string, issues: Array<ValidationIssue>) {
  if (__DEV__) {
    for (let i = 0; i < issues.length; i++) {
      const issue = issues[i];
      const dedupeKey = key + '\n' + issue.rule;
      if (reported.has(dedupeKey)) {
        continue;
      }
      reported.add(dedupeKey);
      if (issue.level === 'error') {
        console.error('WebMCP: %s', issue.message);
      } else {
        console.warn('WebMCP: %s', issue.message);
      }
    }
  }
}

// Test-only: forget which issues were already reported.
export function resetReportedIssuesForTesting() {
  reported.clear();
}
