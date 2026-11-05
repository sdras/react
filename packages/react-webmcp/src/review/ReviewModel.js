/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

// The pure half of the review overlay: how proposals, live registry records
// and the reviewer's decisions combine into what the overlay shows, and what
// "Export accepted" produces. Nothing here touches React or the DOM, so it is
// unit-tested directly and could back another surface later.

import type {Lifetime, PublicToolRecord, Safety} from 'shared/ReactWebMCPTypes';
import type {
  ProposalEdits,
  ProposalEvidence,
  ProposalInputSchema,
  ProposalSchemaProperty,
  ReviewDecision,
  ReviewExport,
  SourceLocation,
  ToolProposal,
} from '../ReactWebMCPProposalTypes';

export type ReviewStatus =
  | 'proposed'
  | 'accepted'
  | 'rejected'
  | 'exported'
  | 'ungrounded';

export type ReviewChecks = {
  ok: number,
  // Checks that have run (everything but `pending`).
  total: number,
  hasWarn: boolean,
  hasBad: boolean,
};

export type ReviewEntry = {
  id: string,
  // The proposal with the reviewer's edits applied.
  tool: ToolProposal,
  // The proposal as inferred, for "reset" and for diffing.
  original: ToolProposal,
  decision: ReviewDecision | null,
  status: ReviewStatus,
  // A registry record with this qualified name exists in the page right now.
  live: boolean,
  checks: ReviewChecks,
  // Unreviewed or accepted, with a warning or failure among its checks.
  needsAttention: boolean,
};

export type GroupBy = 'route' | 'scope' | 'file';

export type Chip = 'proposed' | 'accepted' | 'attention';

export type ReviewGroup = {
  key: string,
  label: string,
  entries: Array<ReviewEntry>,
  accepted: number,
  // Proposed entries with no warnings, eligible for "Accept N grounded".
  groundedProposed: number,
};

export type ReviewProgress = {
  reviewed: number,
  reviewable: number,
  percent: number,
};

export type SchemaPropertyRow = {
  name: string,
  type: string,
  required: boolean,
  description: string,
};

export type DecisionMap = Map<string, ReviewDecision>;

const SAFETY_LABELS: {[Safety]: string} = {
  read: 'read',
  mutate: 'mutate',
  irreversible: 'consequential',
};

export const SAFETY_ORDER: Array<Safety> = ['read', 'mutate', 'irreversible'];
export const LIFETIME_ORDER: Array<Lifetime> = ['app', 'route', 'view'];

export function safetyLabel(safety: Safety): string {
  return SAFETY_LABELS[safety] || safety;
}

export function qualifiedNameFor(
  scopePath: $ReadOnlyArray<string>,
  name: string,
): string {
  return scopePath.concat(name).join('_');
}

// Merges two partial edit records; fields present in `patch` win.
export function mergeEdits(
  base: ProposalEdits | null | void,
  patch: ProposalEdits | null | void,
): ProposalEdits {
  const merged: ProposalEdits = {};
  const sources = [base, patch];
  for (let i = 0; i < sources.length; i++) {
    const source = sources[i];
    if (source == null) {
      continue;
    }
    if (source.name !== undefined) {
      merged.name = source.name;
    }
    if (source.description !== undefined) {
      merged.description = source.description;
    }
    if (source.safety !== undefined) {
      merged.safety = source.safety;
    }
    if (source.lifetime !== undefined) {
      merged.lifetime = source.lifetime;
    }
    if (source.inputSchema !== undefined) {
      merged.inputSchema = source.inputSchema;
    }
  }
  return merged;
}

export function applyEdits(
  proposal: ToolProposal,
  edits: ProposalEdits | null | void,
): ToolProposal {
  if (edits == null) {
    return proposal;
  }
  let changed = false;
  const next = {...proposal};
  const name = edits.name;
  if (name != null && name !== proposal.name) {
    next.name = name;
    next.qualifiedName = qualifiedNameFor(proposal.scopePath, name);
    changed = true;
  }
  const description = edits.description;
  if (description != null && description !== proposal.description) {
    next.description = description;
    changed = true;
  }
  const safety = edits.safety;
  if (safety != null && safety !== proposal.safety) {
    next.safety = safety;
    changed = true;
  }
  const lifetime = edits.lifetime;
  if (lifetime != null && lifetime !== proposal.lifetime) {
    next.lifetime = lifetime;
    changed = true;
  }
  const inputSchema = edits.inputSchema;
  if (inputSchema !== undefined && inputSchema !== proposal.inputSchema) {
    next.inputSchema = inputSchema;
    changed = true;
  }
  return changed ? next : proposal;
}

export function summarizeChecks(
  evidence: $ReadOnlyArray<ProposalEvidence>,
): ReviewChecks {
  let ok = 0;
  let total = 0;
  let hasWarn = false;
  let hasBad = false;
  for (let i = 0; i < evidence.length; i++) {
    const level = evidence[i].level;
    if (level === 'pending') {
      continue;
    }
    total++;
    if (level === 'ok') {
      ok++;
    } else if (level === 'warn') {
      hasWarn = true;
    } else if (level === 'bad') {
      hasBad = true;
    }
  }
  return {ok, total, hasWarn, hasBad};
}

function deriveStatus(
  proposal: ToolProposal,
  decision: ReviewDecision | null,
  live: boolean,
  checks: ReviewChecks,
): ReviewStatus {
  if (proposal.status === 'exported' || live) {
    return 'exported';
  }
  if (decision !== null) {
    return decision.status;
  }
  if (checks.hasBad) {
    return 'ungrounded';
  }
  return 'proposed';
}

function schemaFromRecord(inputSchema: mixed): ProposalInputSchema | null {
  if (
    inputSchema == null ||
    typeof inputSchema !== 'object' ||
    inputSchema.properties == null ||
    typeof inputSchema.properties !== 'object'
  ) {
    return null;
  }
  const properties: {[string]: ProposalSchemaProperty} = {};
  const source: {[string]: mixed} = inputSchema.properties as any;
  for (const key in source) {
    const value = source[key];
    properties[key] = {
      type:
        value != null &&
        typeof value === 'object' &&
        typeof value.type === 'string'
          ? value.type
          : 'string',
      description:
        value != null &&
        typeof value === 'object' &&
        typeof value.description === 'string'
          ? value.description
          : '',
    };
  }
  return {
    type: 'object',
    properties,
    required: Array.isArray(inputSchema.required)
      ? inputSchema.required.filter(name => typeof name === 'string')
      : [],
  };
}

// A registry record that no proposal mentions still belongs in the list: the
// reviewer should see the whole agent-facing surface, not only what inference
// found.
export function proposalFromLiveTool(record: PublicToolRecord): ToolProposal {
  return {
    id: 'live:' + record.qualifiedName,
    name: record.name,
    qualifiedName: record.qualifiedName,
    scopePath: record.scopePath.slice(),
    route: '/' + record.scopePath.join('/'),
    description: record.description,
    safety: record.safety == null ? 'mutate' : record.safety,
    lifetime: record.lifetime,
    inputSchema: schemaFromRecord(record.inputSchema),
    binding: {
      kind:
        record.source === 'tree' ? 'existing-tool-element' : 'existing-hook',
      file: '',
      line: 0,
      column: 0,
      component: null,
      handler: null,
      params: [],
      paramStyle: 'none',
    },
    evidence: [
      {
        check: 'binding',
        level: 'ok',
        summary: 'registered in this page (' + record.status + ')',
        location: null,
      },
    ],
    status: 'exported',
    inferredAt: '',
    provider: null,
  };
}

export function buildEntries(
  proposals: $ReadOnlyArray<ToolProposal>,
  liveTools: $ReadOnlyArray<PublicToolRecord>,
  decisions: DecisionMap,
): Array<ReviewEntry> {
  const liveNames = new Set<string>();
  for (let i = 0; i < liveTools.length; i++) {
    liveNames.add(liveTools[i].qualifiedName);
  }
  const seenNames = new Set<string>();
  const entries: Array<ReviewEntry> = [];
  for (let i = 0; i < proposals.length; i++) {
    const original = proposals[i];
    const decision = decisions.get(original.id) || null;
    const tool = applyEdits(
      original,
      decision !== null ? decision.edits : null,
    );
    const live =
      liveNames.has(tool.qualifiedName) ||
      liveNames.has(original.qualifiedName);
    const checks = summarizeChecks(original.evidence);
    const status = deriveStatus(original, decision, live, checks);
    seenNames.add(original.qualifiedName);
    seenNames.add(tool.qualifiedName);
    entries.push({
      id: original.id,
      tool,
      original,
      decision,
      status,
      live,
      checks,
      needsAttention:
        status !== 'rejected' &&
        status !== 'exported' &&
        (checks.hasWarn || checks.hasBad),
    });
  }
  const liveOnly = liveTools
    .filter(record => !seenNames.has(record.qualifiedName))
    .sort((a, b) => (a.qualifiedName < b.qualifiedName ? -1 : 1));
  for (let i = 0; i < liveOnly.length; i++) {
    const tool = proposalFromLiveTool(liveOnly[i]);
    entries.push({
      id: tool.id,
      tool,
      original: tool,
      decision: null,
      status: 'exported',
      live: true,
      checks: summarizeChecks(tool.evidence),
      needsAttention: false,
    });
  }
  return entries;
}

export function groupKey(entry: ReviewEntry, groupBy: GroupBy): string {
  switch (groupBy) {
    case 'scope':
      return '/' + entry.tool.scopePath.join('/');
    case 'file':
      return entry.tool.binding.file === ''
        ? '(live)'
        : entry.tool.binding.file;
    case 'route':
    default:
      return entry.tool.route === '' ? '/' : entry.tool.route;
  }
}

function getOrCreateGroup(
  groups: Map<string, ReviewGroup>,
  key: string,
): ReviewGroup {
  const existing = groups.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const created: ReviewGroup = {
    key,
    label: key,
    entries: [],
    accepted: 0,
    groundedProposed: 0,
  };
  groups.set(key, created);
  return created;
}

export function groupEntries(
  entries: $ReadOnlyArray<ReviewEntry>,
  groupBy: GroupBy,
): Array<ReviewGroup> {
  const groups: Map<string, ReviewGroup> = new Map();
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const key = groupKey(entry, groupBy);
    const group: ReviewGroup = getOrCreateGroup(groups, key);
    group.entries.push(entry);
    if (entry.status === 'accepted') {
      group.accepted += 1;
    } else if (entry.status === 'proposed' && !entry.needsAttention) {
      group.groundedProposed += 1;
    }
  }
  return Array.from(groups.values()).sort((a, b) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
  );
}

export function matchesQuery(entry: ReviewEntry, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') {
    return true;
  }
  const tool = entry.tool;
  const haystack = [
    tool.qualifiedName,
    tool.name,
    tool.description,
    tool.route,
    tool.binding.component || '',
    tool.binding.handler || '',
    tool.binding.file,
  ]
    .join('\n')
    .toLowerCase();
  return haystack.indexOf(needle) !== -1;
}

export function matchesChip(entry: ReviewEntry, chip: Chip | null): boolean {
  switch (chip) {
    case 'proposed':
      return entry.status === 'proposed' || entry.status === 'ungrounded';
    case 'accepted':
      return entry.status === 'accepted';
    case 'attention':
      return entry.needsAttention;
    default:
      return true;
  }
}

export function filterEntries(
  entries: $ReadOnlyArray<ReviewEntry>,
  query: string,
  chip: Chip | null,
): Array<ReviewEntry> {
  return entries.filter(
    entry => matchesChip(entry, chip) && matchesQuery(entry, query),
  );
}

export function chipCounts(entries: $ReadOnlyArray<ReviewEntry>): {
  proposed: number,
  accepted: number,
  attention: number,
  exported: number,
} {
  const counts = {proposed: 0, accepted: 0, attention: 0, exported: 0};
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (matchesChip(entry, 'proposed')) {
      counts.proposed++;
    }
    if (entry.status === 'accepted') {
      counts.accepted++;
    }
    if (entry.needsAttention) {
      counts.attention++;
    }
    if (entry.status === 'exported') {
      counts.exported++;
    }
  }
  return counts;
}

export function progressOf(
  entries: $ReadOnlyArray<ReviewEntry>,
): ReviewProgress {
  let reviewed = 0;
  let reviewable = 0;
  for (let i = 0; i < entries.length; i++) {
    const status = entries[i].status;
    if (status === 'exported') {
      continue;
    }
    reviewable++;
    if (status === 'accepted' || status === 'rejected') {
      reviewed++;
    }
  }
  return {
    reviewed,
    reviewable,
    percent: reviewable === 0 ? 0 : Math.round((reviewed / reviewable) * 100),
  };
}

// The entry to move to after deciding on `currentId`: the next one in the
// visible list that still needs a decision, wrapping around; null when none.
export function nextUndecidedId(
  visible: $ReadOnlyArray<ReviewEntry>,
  currentId: string | null,
): string | null {
  if (visible.length === 0) {
    return null;
  }
  let start = -1;
  for (let i = 0; i < visible.length; i++) {
    if (visible[i].id === currentId) {
      start = i;
      break;
    }
  }
  for (let offset = 1; offset <= visible.length; offset++) {
    const candidate = visible[(start + offset) % visible.length];
    if (candidate.status === 'proposed' || candidate.status === 'ungrounded') {
      return candidate.id;
    }
  }
  return null;
}

export function buildExport(
  entries: $ReadOnlyArray<ReviewEntry>,
  now: Date,
): ReviewExport {
  const accepted: Array<ToolProposal> = [];
  const rejected: Array<string> = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.status === 'accepted') {
      accepted.push({...entry.tool, status: 'accepted'});
    } else if (entry.status === 'rejected') {
      rejected.push(entry.id);
    }
  }
  return {version: 1, exportedAt: now.toISOString(), accepted, rejected};
}

export function schemaRows(
  schema: ProposalInputSchema | null,
): Array<SchemaPropertyRow> {
  if (schema == null) {
    return [];
  }
  const required = new Set(schema.required);
  return Object.keys(schema.properties).map(name => ({
    name,
    type: schema.properties[name].type,
    required: required.has(name),
    description: schema.properties[name].description,
  }));
}

export function schemaFromRows(
  rows: $ReadOnlyArray<SchemaPropertyRow>,
): ProposalInputSchema | null {
  const named = rows.filter(row => row.name.trim() !== '');
  if (named.length === 0) {
    return null;
  }
  const properties: {[string]: ProposalSchemaProperty} = {};
  const required: Array<string> = [];
  for (let i = 0; i < named.length; i++) {
    const row = named[i];
    properties[row.name.trim()] = {
      type: row.type,
      description: row.description,
    };
    if (row.required) {
      required.push(row.name.trim());
    }
  }
  return {type: 'object', properties, required};
}

// Properties flagged by a schema check, by property name, so the schema editor
// can show "never read" next to the right row.
export function propertyFlags(
  evidence: $ReadOnlyArray<ProposalEvidence>,
): Map<string, ProposalEvidence> {
  const flags = new Map<string, ProposalEvidence>();
  for (let i = 0; i < evidence.length; i++) {
    const item = evidence[i];
    if (
      item.check === 'schema' &&
      item.property != null &&
      (item.level === 'warn' || item.level === 'bad')
    ) {
      flags.set(item.property, item);
    }
  }
  return flags;
}

export type Editor =
  | 'vscode'
  | 'cursor'
  | 'zed'
  | 'idea'
  | 'webstorm'
  | ((location: SourceLocation) => string);

function joinSourcePath(
  sourceRoot: string | null | void,
  file: string,
): string {
  if (sourceRoot == null || sourceRoot === '' || file.charAt(0) === '/') {
    return file;
  }
  return sourceRoot.replace(/\/+$/, '') + '/' + file.replace(/^\.?\/+/, '');
}

// A link that opens a source location in the developer's editor, or null when
// no editor is configured. Paths are joined with `sourceRoot` so the file in a
// proposal (relative to the directory `infer extract` scanned) becomes
// absolute, which is what editor URL schemes want.
export function editorUrlFor(
  editor: Editor | null | void,
  sourceRoot: string | null | void,
  location: SourceLocation,
): string | null {
  if (editor == null) {
    return null;
  }
  if (typeof editor === 'function') {
    return editor(location);
  }
  const file = joinSourcePath(sourceRoot, location.file);
  const line = location.line > 0 ? location.line : 1;
  const column = location.column > 0 ? location.column : 1;
  switch (editor) {
    case 'vscode':
    case 'cursor':
    case 'zed':
      return editor + '://file/' + file + ':' + line + ':' + column;
    case 'idea':
    case 'webstorm':
      return (
        editor +
        '://open?file=' +
        encodeURIComponent(file) +
        '&line=' +
        line +
        '&column=' +
        column
      );
    default:
      return null;
  }
}

export function formatLocation(location: SourceLocation | null | void): string {
  if (location == null) {
    return '';
  }
  return location.file + ':' + location.line;
}

export function describeTimeSince(iso: string, now: Date): string {
  if (iso === '') {
    return '';
  }
  const then = Date.parse(iso);
  if (Number.isNaN(then)) {
    return '';
  }
  const seconds = Math.max(0, Math.round((now.getTime() - then) / 1000));
  if (seconds < 60) {
    return 'inferred just now';
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return 'inferred ' + minutes + ' min ago';
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return 'inferred ' + hours + ' h ago';
  }
  return 'inferred ' + Math.round(hours / 24) + ' days ago';
}

const STORAGE_PREFIX = 'react-webmcp:review:';

export function loadDecisions(storageKey: string): DecisionMap {
  const decisions: DecisionMap = new Map();
  try {
    if (typeof localStorage === 'undefined') {
      return decisions;
    }
    const raw = localStorage.getItem(STORAGE_PREFIX + storageKey);
    if (raw == null) {
      return decisions;
    }
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      for (let i = 0; i < parsed.length; i++) {
        const item = parsed[i];
        if (
          item != null &&
          typeof item.id === 'string' &&
          (item.status === 'accepted' || item.status === 'rejected')
        ) {
          decisions.set(item.id, {
            id: item.id,
            status: item.status,
            edits:
              item.edits != null && typeof item.edits === 'object'
                ? item.edits
                : {},
            decidedAt: typeof item.decidedAt === 'string' ? item.decidedAt : '',
          });
        }
      }
    }
  } catch (error) {
    // Storage can be unavailable or corrupt; the review simply starts fresh.
  }
  return decisions;
}

export function saveDecisions(
  storageKey: string,
  decisions: DecisionMap,
): void {
  try {
    if (typeof localStorage === 'undefined') {
      return;
    }
    localStorage.setItem(
      STORAGE_PREFIX + storageKey,
      JSON.stringify(Array.from(decisions.values())),
    );
  } catch (error) {
    // Best effort only.
  }
}
