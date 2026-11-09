/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {PublicToolRecord, ToolRecord} from 'shared/ReactWebMCPTypes';

import {contentKey} from './ReactDOMWebMCPNames';
import {
  logIssue,
  reportIssues,
  validateKeyCollision,
  validateToolRecord,
} from './ReactDOMWebMCPValidation';

// The in-page registry of every WebMCP tool React currently owns, from the
// hook in react-dom and from the tool tree in react-webmcp. It does not talk
// to the browser; it is the single view that developer tooling (React
// DevTools, chrome-devtools-mcp, the CI contract check) reads.
//
// Records are stored per owner: the hook's ref object or the tree's host
// instance that wrote them. That is the unit a lifecycle acts on, so an owner
// only ever touches its own record, an unmounting component cannot delete the
// record its replacement wrote in the same commit, and a hidden record never
// has to stand in for "being torn down". Tooling reads the registry by key;
// when two owners hold one key the live, most recently written record is
// shown and, in DEV, the collision is reported once the writer's commit has
// settled (see checkToolRecordCollisions).

type Entry = {
  record: ToolRecord,
  // Write order, to pick the record tooling shows for a contested key.
  order: number,
};

const records: Map<mixed, Entry> = new Map();
let nextOrder = 0;
const listeners: Set<() => void> = new Set();
// One record per key, derived from `records`; null while stale.
let keyView: null | Map<string, ToolRecord> = null;
let publicSnapshot: null | $ReadOnlyArray<PublicToolRecord> = null;
let batchDepth = 0;
let pendingEmit = false;
// DEV: owner pairs already reported as a collision. Weak, so a pair is
// reported once for as long as both instances exist, a StrictMode remount of
// the same instances does not repeat it, and a new instance that collides
// with the same key later is reported again.
const reportedCollisions: WeakMap<
  interface {},
  WeakSet<interface {}>,
> = new WeakMap();

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
    a.availability.enabled === b.availability.enabled &&
    a.availability.scopeAvailable === b.availability.scopeAvailable &&
    a.availability.hidden === b.availability.hidden &&
    a.availability.supported === b.availability.supported &&
    contentKey(a.scopePath) === contentKey(b.scopePath) &&
    contentKey(a.inputSchema) === contentKey(b.inputSchema) &&
    contentKey(a.annotations) === contentKey(b.annotations)
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
    contentKey(a.inputSchema) === contentKey(b.inputSchema) &&
    contentKey(a.annotations) === contentKey(b.annotations)
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

// A live record beats a hidden one for the same key; among equals the most
// recent write wins.
function outranks(candidate: Entry, incumbent: Entry): boolean {
  const candidateHidden = candidate.record.availability.hidden;
  const incumbentHidden = incumbent.record.availability.hidden;
  if (candidateHidden !== incumbentHidden) {
    return incumbentHidden;
  }
  return candidate.order > incumbent.order;
}

function getKeyView(): Map<string, ToolRecord> {
  if (keyView === null) {
    const view: Map<string, ToolRecord> = new Map();
    const winners: Map<string, Entry> = new Map();
    records.forEach(entry => {
      const key = entry.record.key;
      const incumbent = winners.get(key);
      if (incumbent === undefined || outranks(entry, incumbent)) {
        winners.set(key, entry);
        // Map.set keeps the position of an existing key, so keys stay in the
        // order they first appeared.
        view.set(key, entry.record);
      }
    });
    keyView = view;
  }
  return keyView;
}

function invalidate(): void {
  keyView = null;
  publicSnapshot = null;
  emit();
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

// Writes the owner's record. Returns whether anything changed.
export function upsertToolRecord(record: ToolRecord): boolean {
  if (__DEV__) {
    installDevToolsHandle();
  }
  const owner = record.ownerToken;
  const previous = records.get(owner);
  if (previous !== undefined && recordsAreEqual(previous.record, record)) {
    return false;
  }
  records.set(owner, {record, order: nextOrder++});
  keyView = null;
  if (__DEV__) {
    if (
      previous === undefined ||
      !definitionsAreEqual(previous.record, record)
    ) {
      reportIssues(record.key, validateToolRecord(record, getKeyView()));
    }
  }
  invalidate();
  return true;
}

export function removeToolRecord(ownerToken: mixed): void {
  if (records.delete(ownerToken)) {
    invalidate();
  }
}

export function getToolRecord(ownerToken: mixed): ToolRecord | void {
  const entry = records.get(ownerToken);
  return entry === undefined ? undefined : entry.record;
}

function hasReportedCollision(a: mixed, b: mixed): boolean {
  if (
    typeof a !== 'object' ||
    a === null ||
    typeof b !== 'object' ||
    b === null
  ) {
    return false;
  }
  const peers = reportedCollisions.get(a);
  if (peers !== undefined && peers.has(b)) {
    return true;
  }
  let own = peers;
  if (own === undefined) {
    own = new WeakSet();
    reportedCollisions.set(a, own);
  }
  own.add(b);
  let theirs = reportedCollisions.get(b);
  if (theirs === undefined) {
    theirs = new WeakSet();
    reportedCollisions.set(b, theirs);
  }
  theirs.add(a);
  return false;
}

// DEV. Reports every other owner that holds this owner's key. Writers call it
// from the passive phase of the commit that wrote the record (the hook's
// effect; the tool tree once its host commit has settled), by which time an
// owner this one replaced in the same commit has removed its record. So a
// replacement is never mistaken for a collision, and a collision with a
// component a Suspense boundary is hiding is reported now, from the component
// that caused it, instead of on reveal from the one that did not.
export function checkToolRecordCollisions(ownerToken: mixed): void {
  if (__DEV__) {
    const entry = records.get(ownerToken);
    if (entry === undefined) {
      return;
    }
    const record = entry.record;
    records.forEach((other, otherOwner) => {
      if (
        otherOwner !== ownerToken &&
        other.record.key === record.key &&
        !hasReportedCollision(ownerToken, otherOwner)
      ) {
        logIssue(validateKeyCollision(record));
      }
    });
  }
}

// Internal records, including owner tokens. Read by developer tooling through
// the DEV-only global below.
export function getToolRecords(): Array<ToolRecord> {
  return Array.from(getKeyView().values());
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
    getKeyView().forEach(record => {
      snapshot.push(toPublicRecord(record));
    });
    publicSnapshot = snapshot;
  }
  return publicSnapshot;
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
