/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {PublicToolRecord, ToolRecord} from './ReactWebMCPTypes';

import {safeStringify} from './ReactWebMCPNames';
import {reportIssues, validateToolRecord} from './ReactWebMCPValidation';

// The in-page registry of every tool React currently owns, from both the hook
// path and the tool tree. It does not talk to the browser; it is the single
// view that developer tooling (React DevTools, chrome-devtools-mcp, the CI
// contract check) reads.

const records: Map<string, ToolRecord> = new Map();
const listeners: Set<() => void> = new Set();
let publicSnapshot: $ReadOnlyArray<PublicToolRecord> | null = null;
let batchDepth = 0;
let pendingEmit = false;

function emit(): void {
  if (batchDepth > 0) {
    pendingEmit = true;
    return;
  }
  // Copy so a listener can unsubscribe while we iterate.
  const current = Array.from(listeners);
  for (let i = 0; i < current.length; i++) {
    current[i]();
  }
}

function recordsAreEqual(a: ToolRecord, b: ToolRecord): boolean {
  return (
    a.key === b.key &&
    a.qualifiedName === b.qualifiedName &&
    a.name === b.name &&
    a.description === b.description &&
    a.safety === b.safety &&
    a.lifetime === b.lifetime &&
    a.source === b.source &&
    a.status === b.status &&
    a.error === b.error &&
    a.ownerToken === b.ownerToken &&
    a.availability.enabled === b.availability.enabled &&
    a.availability.scopeAvailable === b.availability.scopeAvailable &&
    a.availability.hidden === b.availability.hidden &&
    a.availability.supported === b.availability.supported &&
    safeStringify(a.scopePath) === safeStringify(b.scopePath) &&
    safeStringify(a.inputSchema) === safeStringify(b.inputSchema) &&
    safeStringify(a.annotations) === safeStringify(b.annotations)
  );
}

function toPublicRecord(record: ToolRecord): PublicToolRecord {
  return {
    key: record.key,
    qualifiedName: record.qualifiedName,
    name: record.name,
    scopePath: record.scopePath,
    description: record.description,
    inputSchema: record.inputSchema,
    annotations: record.annotations,
    safety: record.safety,
    lifetime: record.lifetime,
    source: record.source,
    status: record.status,
    availability: record.availability,
    error: record.error,
  };
}

// Group several upserts/removes into one notification (used by the tool tree
// after each commit).
export function batchToolRecordUpdates<T>(fn: () => T): T {
  batchDepth++;
  try {
    return fn();
  } finally {
    batchDepth--;
    if (batchDepth === 0 && pendingEmit) {
      pendingEmit = false;
      emit();
    }
  }
}

export function upsertToolRecord(record: ToolRecord): void {
  const previous = records.get(record.key);
  if (previous !== undefined && recordsAreEqual(previous, record)) {
    return;
  }
  if (__DEV__) {
    reportIssues(record.key, validateToolRecord(record, records));
  }
  records.set(record.key, record);
  publicSnapshot = null;
  emit();
}

export function removeToolRecord(key: string): void {
  if (records.delete(key)) {
    publicSnapshot = null;
    emit();
  }
}

export function getToolRecord(key: string): ToolRecord | void {
  return records.get(key);
}

// Internal records, including owner tokens. Read by developer tooling through
// the DEV-only global below.
export function getToolRecords(): Array<ToolRecord> {
  return Array.from(records.values());
}

export function subscribeToRegisteredTools(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// Stable while nothing changed, so it can back useSyncExternalStore.
export function getRegisteredTools(): $ReadOnlyArray<PublicToolRecord> {
  if (publicSnapshot === null) {
    const snapshot = [];
    records.forEach(record => {
      snapshot.push(toPublicRecord(record));
    });
    publicSnapshot = snapshot;
  }
  return publicSnapshot;
}

// Test-only.
export function resetRegistryForTesting(): void {
  records.clear();
  listeners.clear();
  publicSnapshot = null;
}

export const REGISTRY_GLOBAL_KEY = '__REACT_WEBMCP__';

// Developer tooling (react-devtools-facade, chrome-devtools-mcp) reads the
// registry through this handle rather than importing the app's copy of
// react-webmcp. DEV only: production builds expose nothing.
if (__DEV__) {
  const globalObject: any =
    typeof globalThis !== 'undefined'
      ? globalThis
      : typeof window !== 'undefined'
        ? window
        : null;
  if (globalObject !== null) {
    if (globalObject[REGISTRY_GLOBAL_KEY] == null) {
      globalObject[REGISTRY_GLOBAL_KEY] = {
        version: 1,
        getTools: getToolRecords,
        subscribe: subscribeToRegisteredTools,
      };
    } else {
      console.warn(
        'react-webmcp: Multiple copies of react-webmcp were loaded on this ' +
          'page. Developer tooling will only see the tools of the first copy. ' +
          'Make sure your bundler resolves a single copy of the package.',
      );
    }
  }
}
