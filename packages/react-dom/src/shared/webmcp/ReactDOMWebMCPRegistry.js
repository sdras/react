/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {PublicToolRecord, ToolRecord} from 'shared/ReactWebMCPTypes';

import {safeStringify} from './ReactDOMWebMCPNames';
import {reportIssues, validateToolRecord} from './ReactDOMWebMCPValidation';

// The in-page registry of every WebMCP tool React currently owns, from the
// hook in react-dom and from the tool tree in react-webmcp. It does not talk
// to the browser; it is the single view that developer tooling (React
// DevTools, chrome-devtools-mcp, the CI contract check) reads.

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

// The agent-visible definition, as opposed to status and availability. Only a
// change here is worth validating again; a tool going hidden or disabled is
// not a new problem.
function definitionsAreEqual(a: ToolRecord, b: ToolRecord): boolean {
  return (
    a.qualifiedName === b.qualifiedName &&
    a.name === b.name &&
    a.description === b.description &&
    a.safety === b.safety &&
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
  if (__DEV__) {
    installDevToolsHandle();
  }
  const previous = records.get(record.key);
  if (previous !== undefined && recordsAreEqual(previous, record)) {
    return;
  }
  if (__DEV__) {
    if (previous === undefined || !definitionsAreEqual(previous, record)) {
      reportIssues(record.key, validateToolRecord(record, records));
    }
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
// registry through this handle rather than importing react-dom. DEV only, and
// installed lazily on the first record rather than when the module loads, so
// a page (or a test) that never registers a tool exposes nothing. The last
// copy of react-dom to register a tool owns the handle.
function installDevToolsHandle(): void {
  if (__DEV__) {
    const globalObject: any =
      typeof globalThis !== 'undefined'
        ? globalThis
        : typeof window !== 'undefined'
          ? window
          : null;
    if (globalObject === null) {
      return;
    }
    const existing = globalObject[REGISTRY_GLOBAL_KEY];
    if (existing != null && existing.getTools === getToolRecords) {
      return;
    }
    globalObject[REGISTRY_GLOBAL_KEY] = {
      version: 1,
      getTools: getToolRecords,
      subscribe: subscribeToRegisteredTools,
    };
  }
}
