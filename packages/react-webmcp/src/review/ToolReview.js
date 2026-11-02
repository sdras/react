/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

// The developer review overlay for proposed agent tools. An app renders it in
// development; it lists the proposals `yarn infer-tools extract` wrote, the
// tools currently registered in the page, lets the developer edit, accept or
// reject each proposal, and hands the accepted set to `yarn infer-tools emit`.
// Nothing here ever registers a tool or writes source on its own.

import * as React from 'react';
import {
  unstable_getRegisteredTools,
  unstable_subscribeToRegisteredTools,
} from 'react-webmcp';

import type {Lifetime, Safety} from '../ReactWebMCPTypes';
import type {
  ProposalEdits,
  ProposalEvidence,
  ReviewExport,
  SourceLocation,
  ToolProposal,
} from '../ReactWebMCPProposalTypes';
import type {
  Chip,
  DecisionMap,
  Editor,
  GroupBy,
  ReviewEntry,
  ReviewGroup,
  SchemaPropertyRow,
} from './ReviewModel';

import {
  LIFETIME_ORDER,
  SAFETY_ORDER,
  applyEdits,
  buildEntries,
  buildExport,
  chipCounts,
  describeTimeSince,
  editorUrlFor,
  filterEntries,
  formatLocation,
  groupEntries,
  loadDecisions,
  mergeEdits,
  nextUndecidedId,
  progressOf,
  propertyFlags,
  safetyLabel,
  saveDecisions,
  schemaFromRows,
  schemaRows,
} from './ReviewModel';
import {REVIEW_CSS} from './reviewStyles';

const {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} = React;

export type ToolReviewProps = {
  // The `proposals` array of a tools.proposals.json file.
  proposals: $ReadOnlyArray<ToolProposal>,
  // Render nothing while false. Defaults to true.
  open?: boolean,
  // Called for the close button and the Escape key.
  onClose?: () => void,
  // Receives the accepted tools (with edits applied) and the rejected ids.
  // Without a handler the overlay downloads `tools.accepted.json`.
  onExport?: (data: ReviewExport) => void,
  // Called when a source location in the evidence is clicked. Without it,
  // `editor` turns locations into links.
  onOpenSource?: (location: SourceLocation) => void,
  // Which editor to open source locations in ('vscode', 'cursor', 'zed',
  // 'idea', 'webstorm', or a function returning a URL). Proposal files are
  // relative to the scanned directory; give that directory's absolute path as
  // `sourceRoot` so the links resolve.
  editor?: Editor | null,
  sourceRoot?: string | null,
  // Decisions persist in localStorage under this key so a reload keeps the
  // reviewer's progress. Pass null to keep them in memory only.
  storageKey?: string | null,
  defaultGroupBy?: GroupBy,
  title?: string,
  subtitle?: string,
};

const PROPERTY_TYPES = [
  'string',
  'number',
  'integer',
  'boolean',
  'array',
  'object',
];

const GROUP_OPTIONS: Array<GroupBy> = ['route', 'scope', 'file'];

function groupLabel(groupBy: GroupBy): string {
  return groupBy;
}

function toGroupBy(value: string): GroupBy {
  return value === 'scope' || value === 'file' ? value : 'route';
}

function pluralize(count: number, noun: string): string {
  return count + ' ' + noun + (count === 1 ? '' : 's');
}

function isEditable(target: EventTarget): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tag = target.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    target.isContentEditable === true
  );
}

function downloadJSON(filename: string, data: mixed): void {
  if (typeof document === 'undefined' || typeof Blob === 'undefined') {
    return;
  }
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([(json == null ? '' : json) + '\n'], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  if (document.body != null) {
    document.body.appendChild(anchor);
  }
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

// ---------------------------------------------------------------------------
// Icons (from the design, 24px viewBox, stroked).
// ---------------------------------------------------------------------------

function Icon({d, className}: {d: string, className?: string}): React.Node {
  return (
    <svg
      className={'rwr-Icon' + (className != null ? ' ' + className : '')}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

const ICON_CLOSE = 'M6 6l12 12M18 6L6 18';
const ICON_SEARCH = 'M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14zM20 20l-3.5-3.5';
const ICON_WARN = 'M12 3l10 18H2L12 3zM12 10v5M12 18.5v.5';
const ICON_OK = 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM8 12.5l2.5 2.5L16 9.5';
const ICON_BAD = 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM9 9l6 6M15 9l-6 6';
const ICON_PENDING = 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM8 12h8';
const ICON_SHIELD =
  'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3zM9 12l2 2 4-4';
const ICON_PLUS = 'M12 5v14M5 12h14';
const ICON_NEXT = 'M5 12h14M13 6l6 6-6 6';
const ICON_EXPORT = 'M14 5h5v5M19 5l-8 8M17 14v5H5V7h5';

function levelIcon(level: string): React.Node {
  switch (level) {
    case 'ok':
      return <Icon d={ICON_OK} className="rwr-ok" />;
    case 'warn':
      return <Icon d={ICON_WARN} className="rwr-warn" />;
    case 'bad':
      return <Icon d={ICON_BAD} className="rwr-bad" />;
    default:
      return <Icon d={ICON_PENDING} className="rwr-pending" />;
  }
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function StatusTag({status}: {status: string}): React.Node {
  return <span className={'rwr-Tag rwr-Tag-' + status}>{status}</span>;
}

function SafetyTag({safety}: {safety: Safety}): React.Node {
  return (
    <span className={'rwr-Tag rwr-Tag-' + safety}>{safetyLabel(safety)}</span>
  );
}

function LocationLink({
  location,
  onOpenSource,
  editor,
  sourceRoot,
}: {
  location: SourceLocation,
  onOpenSource: ?(location: SourceLocation) => void,
  editor: ?Editor,
  sourceRoot: ?string,
}): React.Node {
  const label = formatLocation(location);
  if (onOpenSource != null) {
    const open = onOpenSource;
    return (
      <button
        type="button"
        className="rwr-EvLink"
        onClick={() => open(location)}>
        {label}
      </button>
    );
  }
  const href = editorUrlFor(editor, sourceRoot, location);
  if (href != null) {
    return (
      <a className="rwr-EvLink" href={href} title={href}>
        {label}
      </a>
    );
  }
  return <span className="rwr-Mono">{label}</span>;
}

function EvidenceCard({
  entry,
  now,
  onOpenSource,
  editor,
  sourceRoot,
}: {
  entry: ReviewEntry,
  now: Date,
  onOpenSource: ?(location: SourceLocation) => void,
  editor: ?Editor,
  sourceRoot: ?string,
}): React.Node {
  const {checks} = entry;
  const evidence = entry.original.evidence;
  let headline;
  let headClass;
  if (checks.total === 0) {
    headline = 'No checks yet';
    headClass = 'rwr-pending';
  } else if (checks.hasBad) {
    headline = 'Ungrounded · ' + checks.ok + ' of ' + checks.total + ' checks';
    headClass = 'rwr-bad';
  } else if (checks.hasWarn) {
    headline =
      'Grounded with warnings · ' +
      checks.ok +
      ' of ' +
      checks.total +
      ' checks';
    headClass = 'rwr-warn';
  } else {
    headline = 'Grounded · ' + checks.ok + ' of ' + checks.total + ' checks';
    headClass = 'rwr-ok';
  }
  return (
    <div className="rwr-Evidence">
      <div className={'rwr-EvidenceHead ' + headClass}>
        <Icon d={ICON_SHIELD} />
        <span>{headline}</span>
        <span className="rwr-EvidenceMeta">
          {describeTimeSince(entry.original.inferredAt, now)}
        </span>
      </div>
      {evidence.map((item: ProposalEvidence, index) => (
        <div key={index} className={'rwr-EvRow rwr-' + item.level}>
          {levelIcon(item.level)}
          <span>
            {item.summary}
            {item.location != null ? (
              <>
                {' · '}
                <LocationLink
                  location={item.location}
                  onOpenSource={onOpenSource}
                  editor={editor}
                  sourceRoot={sourceRoot}
                />
              </>
            ) : null}
          </span>
        </div>
      ))}
    </div>
  );
}

function Segmented<T: string>({
  value,
  options,
  labels,
  onChange,
  ariaLabel,
}: {
  value: T,
  options: Array<T>,
  labels: T => string,
  onChange: T => void,
  ariaLabel: string,
}): React.Node {
  return (
    <div className="rwr-Segmented" role="group" aria-label={ariaLabel}>
      {options.map(option => (
        <button
          key={option}
          type="button"
          className={'rwr-Seg' + (option === value ? ' rwr-SegOn' : '')}
          aria-pressed={option === value}
          onClick={() => onChange(option)}>
          {labels(option)}
        </button>
      ))}
    </div>
  );
}

// Owns its rows while the reviewer edits: a property that is not named yet
// would otherwise be dropped from the schema (and the list) on every change.
// The parent remounts it (by key) when another tool is selected.
function SchemaEditor({
  initialRows,
  flags,
  onChange,
}: {
  initialRows: Array<SchemaPropertyRow>,
  flags: Map<string, ProposalEvidence>,
  onChange: (Array<SchemaPropertyRow>) => void,
}): React.Node {
  const [rows, setRows] = useState<Array<SchemaPropertyRow>>(initialRows);
  const change = (next: Array<SchemaPropertyRow>) => {
    setRows(next);
    onChange(next);
  };
  const update = (index: number, patch: Partial<SchemaPropertyRow>) => {
    const next = rows.slice();
    next[index] = {...next[index], ...patch};
    change(next);
  };
  return (
    <div className="rwr-Field">
      <div className="rwr-SchemaHead">
        <span className="rwr-Label">Input schema</span>
        <button
          type="button"
          className="rwr-Add"
          onClick={() =>
            change(
              rows.concat({
                name: '',
                type: 'string',
                required: false,
                description: '',
              }),
            )
          }>
          <Icon d={ICON_PLUS} />
          Property
        </button>
      </div>
      <div className="rwr-Props">
        {rows.length === 0 ? (
          <div className="rwr-PropEmpty">
            No parameters. The tool takes no input.
          </div>
        ) : null}
        {rows.map((row, index) => {
          const flag = flags.get(row.name);
          return (
            <div key={index} className="rwr-Prop">
              <input
                className="rwr-PropInput rwr-PropName"
                aria-label={'Property ' + (index + 1) + ' name'}
                value={row.name}
                placeholder="name"
                onChange={event =>
                  update(index, {name: event.currentTarget.value})
                }
              />
              <select
                className="rwr-PropInput rwr-PropType"
                aria-label={'Property ' + (index + 1) + ' type'}
                value={row.type}
                onChange={event =>
                  update(index, {type: event.currentTarget.value})
                }>
                {PROPERTY_TYPES.map(type => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
              <input
                className="rwr-PropReq"
                type="checkbox"
                aria-label={'Property ' + (index + 1) + ' required'}
                title="required"
                checked={row.required}
                onChange={event =>
                  update(index, {required: event.currentTarget.checked})
                }
              />
              <input
                className="rwr-PropInput rwr-PropDesc"
                aria-label={'Property ' + (index + 1) + ' description'}
                value={row.description}
                placeholder="description"
                onChange={event =>
                  update(index, {description: event.currentTarget.value})
                }
              />
              {flag != null ? (
                <span className="rwr-PropFlag" title={flag.summary}>
                  <Icon d={ICON_WARN} />
                  {flag.summary.replace(row.name, '').trim() || flag.summary}
                </span>
              ) : (
                <button
                  type="button"
                  className="rwr-PropRemove"
                  aria-label={'Remove property ' + (row.name || index + 1)}
                  onClick={() =>
                    change(rows.filter((_, candidate) => candidate !== index))
                  }>
                  <Icon d={ICON_CLOSE} />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The overlay
// ---------------------------------------------------------------------------

export function ToolReview(props: ToolReviewProps): React.Node {
  const {
    proposals,
    open = true,
    onClose,
    onExport,
    onOpenSource,
    editor = null,
    sourceRoot = null,
    storageKey = 'default',
    defaultGroupBy = 'route',
    title = 'Review agent tools',
    subtitle,
  } = props;

  const liveTools = useSyncExternalStore(
    unstable_subscribeToRegisteredTools,
    unstable_getRegisteredTools,
    unstable_getRegisteredTools,
  );

  const [decisions, setDecisions] = useState<DecisionMap>(() =>
    storageKey == null ? new Map() : loadDecisions(storageKey),
  );
  // Unsaved edits per proposal, kept until the reviewer decides.
  const [drafts, setDrafts] = useState<Map<string, ProposalEdits>>(
    () => new Map(),
  );
  const [query, setQuery] = useState('');
  const [chip, setChip] = useState<Chip | null>(null);
  const [groupBy, setGroupBy] = useState<GroupBy>(defaultGroupBy);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [now] = useState(() => new Date());

  const searchRef = useRef<HTMLInputElement | null>(null);
  const titleId = useId();
  const subtitleId = useId();

  const entries = useMemo(
    () => buildEntries(proposals, liveTools, decisions),
    [proposals, liveTools, decisions],
  );
  const visible = useMemo(
    () => filterEntries(entries, query, chip),
    [entries, query, chip],
  );
  const groups: Array<ReviewGroup> = useMemo(
    () => groupEntries(visible, groupBy),
    [visible, groupBy],
  );
  // The rows in the order the list shows them (grouped and sorted), which is
  // the order keyboard navigation and "accept and next" follow.
  const ordered: Array<ReviewEntry> = useMemo(() => {
    const list = [];
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      for (let j = 0; j < group.entries.length; j++) {
        list.push(group.entries[j]);
      }
    }
    return list;
  }, [groups]);
  const counts = useMemo(() => chipCounts(entries), [entries]);
  const progress = useMemo(() => progressOf(entries), [entries]);
  const candidates = entries.length - counts.exported;

  // Keep a valid selection: the chosen row if it is still visible, otherwise
  // the first row that needs a decision, otherwise the first row.
  let effectiveSelectedId = null;
  if (ordered.length > 0) {
    if (selectedId !== null && ordered.some(entry => entry.id === selectedId)) {
      effectiveSelectedId = selectedId;
    } else {
      effectiveSelectedId = nextUndecidedId(ordered, null);
      if (effectiveSelectedId === null) {
        effectiveSelectedId = ordered[0].id;
      }
    }
  }
  const selected: ReviewEntry | null =
    effectiveSelectedId === null
      ? null
      : entries.find(entry => entry.id === effectiveSelectedId) || null;
  const selectedDraft: ProposalEdits | null =
    selected === null ? null : drafts.get(selected.id) || null;
  const shown: ToolProposal | null =
    selected === null ? null : applyEdits(selected.tool, selectedDraft);

  const persist = useCallback(
    (next: DecisionMap) => {
      setDecisions(next);
      if (storageKey != null) {
        saveDecisions(storageKey, next);
      }
    },
    [storageKey],
  );

  const updateDraft = useCallback((id: string, patch: ProposalEdits) => {
    setDrafts(previous => {
      const next = new Map(previous);
      next.set(id, mergeEdits(previous.get(id), patch));
      return next;
    });
  }, []);

  const decide = useCallback(
    (id: string, status: 'accepted' | 'rejected', advance: boolean) => {
      const existing = decisions.get(id);
      const next = new Map(decisions);
      next.set(id, {
        id,
        status,
        edits: mergeEdits(
          existing != null ? existing.edits : null,
          drafts.get(id),
        ),
        decidedAt: new Date().toISOString(),
      });
      persist(next);
      if (drafts.has(id)) {
        setDrafts(previous => {
          const cleared = new Map(previous);
          cleared.delete(id);
          return cleared;
        });
      }
      if (advance) {
        const nextId = nextUndecidedId(ordered, id);
        if (nextId !== null) {
          setSelectedId(nextId);
        }
      }
    },
    [decisions, drafts, persist, ordered],
  );

  const undecide = useCallback(
    (id: string) => {
      if (!decisions.has(id)) {
        return;
      }
      const next = new Map(decisions);
      next.delete(id);
      persist(next);
    },
    [decisions, persist],
  );

  const acceptGrounded = useCallback(
    (group: ReviewGroup) => {
      const next = new Map(decisions);
      const decidedAt = new Date().toISOString();
      for (let i = 0; i < group.entries.length; i++) {
        const entry = group.entries[i];
        if (entry.status === 'proposed' && !entry.needsAttention) {
          next.set(entry.id, {
            id: entry.id,
            status: 'accepted',
            edits: mergeEdits(null, drafts.get(entry.id)),
            decidedAt,
          });
        }
      }
      persist(next);
    },
    [decisions, drafts, persist],
  );

  const handleExport = useCallback(() => {
    const data = buildExport(entries, new Date());
    if (onExport != null) {
      onExport(data);
    } else {
      downloadJSON('tools.accepted.json', data);
    }
  }, [entries, onExport]);

  const moveSelection = useCallback(
    (delta: number) => {
      if (ordered.length === 0) {
        return;
      }
      let index = ordered.findIndex(entry => entry.id === effectiveSelectedId);
      if (index === -1) {
        index = 0;
      }
      const nextIndex = Math.min(
        ordered.length - 1,
        Math.max(0, index + delta),
      );
      setSelectedId(ordered[nextIndex].id);
    },
    [ordered, effectiveSelectedId],
  );

  const handleKeyDown = (event: KeyboardEvent) => {
    const target = event.target;
    const editable = isEditable(target);
    if (event.key === 'Escape') {
      if (editable && target !== searchRef.current) {
        // Leave the field first; a second Escape closes.
        if (target instanceof HTMLElement) {
          target.blur();
        }
        event.preventDefault();
        return;
      }
      if (onClose != null) {
        event.preventDefault();
        onClose();
      }
      return;
    }
    if (editable || event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }
    switch (event.key) {
      case '/':
        event.preventDefault();
        if (searchRef.current != null) {
          searchRef.current.focus();
        }
        break;
      case 'ArrowDown':
      case 'j':
        event.preventDefault();
        moveSelection(1);
        break;
      case 'ArrowUp':
      case 'k':
        event.preventDefault();
        moveSelection(-1);
        break;
      case 'a':
      case 'A':
        if (selected !== null && selected.status !== 'exported') {
          event.preventDefault();
          decide(selected.id, 'accepted', true);
        }
        break;
      case 'r':
      case 'R':
        if (selected !== null && selected.status !== 'exported') {
          event.preventDefault();
          decide(selected.id, 'rejected', true);
        }
        break;
      default:
        break;
    }
  };

  // Focus the search on open, lock the page behind the overlay, and put
  // focus back where it was on close.
  useEffect(() => {
    if (!open || typeof document === 'undefined') {
      return undefined;
    }
    const previouslyFocused = document.activeElement;
    const body = document.body;
    const previousOverflow = body != null ? body.style.overflow : '';
    if (body != null) {
      body.style.overflow = 'hidden';
    }
    if (searchRef.current != null) {
      searchRef.current.focus();
    }
    return () => {
      if (body != null) {
        body.style.overflow = previousOverflow;
      }
      if (previouslyFocused instanceof HTMLElement) {
        previouslyFocused.focus();
      }
    };
  }, [open]);

  if (!open) {
    return null;
  }

  const remaining = progress.reviewable - progress.reviewed;
  const chipDefinitions: Array<{value: Chip, label: string, count: number}> = [
    {value: 'proposed', label: 'Proposed', count: counts.proposed},
    {value: 'accepted', label: 'Accepted', count: counts.accepted},
    {value: 'attention', label: 'Needs attention', count: counts.attention},
  ];
  const effectiveSubtitle =
    subtitle != null
      ? subtitle
      : candidates === 0
        ? 'No candidates yet. Run `yarn infer-tools extract` against your app source to propose tools from its handlers and forms.'
        : pluralize(candidates, 'candidate') +
          ' found in your handlers, forms and hooks. Nothing ships until you export.';

  let selectedGroupPosition = '';
  if (selected !== null) {
    const group = groups.find(candidate =>
      candidate.entries.some(entry => entry.id === selected.id),
    );
    if (group != null) {
      const index = group.entries.findIndex(entry => entry.id === selected.id);
      selectedGroupPosition =
        index + 1 + ' of ' + group.entries.length + ' in ' + group.label;
    }
  }

  return (
    <div
      className="rwr-Root"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={subtitleId}
      onKeyDown={handleKeyDown}>
      <style>{REVIEW_CSS}</style>
      <div className="rwr-Modal">
        <div className="rwr-Header">
          <div className="rwr-HeaderText">
            <h2 className="rwr-Title" id={titleId}>
              {title}
            </h2>
            <p className="rwr-Subtitle" id={subtitleId}>
              {effectiveSubtitle}
            </p>
          </div>
          <div className="rwr-Progress" aria-live="polite">
            <div className="rwr-ProgressLabel">
              <span>
                {progress.reviewed} of {progress.reviewable} reviewed
              </span>
              <span>{progress.percent}%</span>
            </div>
            <div
              className="rwr-ProgressBar"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress.percent}>
              <div
                className="rwr-ProgressFill"
                style={{width: progress.percent + '%'}}
              />
            </div>
          </div>
          <button
            type="button"
            className="rwr-IconBtn"
            title="Close"
            aria-label="Close"
            onClick={onClose}>
            <Icon d={ICON_CLOSE} />
          </button>
        </div>

        <div className="rwr-Toolbar">
          <label className="rwr-Search">
            <Icon d={ICON_SEARCH} />
            <input
              ref={searchRef}
              className="rwr-SearchInput"
              type="search"
              placeholder="Search tools"
              aria-label="Search tools"
              value={query}
              onChange={event => setQuery(event.currentTarget.value)}
            />
            <span className="rwr-Kbd" aria-hidden="true">
              /
            </span>
          </label>
          <div className="rwr-Chips" role="group" aria-label="Filter">
            {chipDefinitions.map(definition => (
              <button
                key={definition.value}
                type="button"
                className={
                  'rwr-Chip' + (chip === definition.value ? ' rwr-ChipOn' : '')
                }
                aria-pressed={chip === definition.value}
                onClick={() =>
                  setChip(chip === definition.value ? null : definition.value)
                }>
                {definition.label}{' '}
                <span className="rwr-ChipCount">{definition.count}</span>
              </button>
            ))}
          </div>
          <div className="rwr-Spacer" />
          <label className="rwr-Select">
            Group by
            <select
              aria-label="Group by"
              value={groupBy}
              onChange={event =>
                setGroupBy(toGroupBy(event.currentTarget.value))
              }>
              {GROUP_OPTIONS.map(option => (
                <option key={option} value={option}>
                  {groupLabel(option)}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="rwr-Body">
          <div className="rwr-List">
            <div className="rwr-ListHead" aria-hidden="true">
              <span>Tool</span>
              <span>Safety</span>
              <span>Status</span>
            </div>
            <div className="rwr-Rows" role="listbox" aria-label="Tools">
              {visible.length === 0 ? (
                <div className="rwr-Empty">
                  {entries.length === 0
                    ? 'Nothing to review yet.'
                    : 'No tools match this filter.'}
                </div>
              ) : null}
              {groups.map(group => (
                <React.Fragment key={group.key}>
                  <div className="rwr-GroupHead">
                    <span className="rwr-GroupName">{group.label}</span>
                    <span className="rwr-GroupMeta">
                      {pluralize(group.entries.length, 'tool')} ·{' '}
                      {group.accepted} accepted
                    </span>
                    {group.groundedProposed > 0 ? (
                      <button
                        type="button"
                        className="rwr-GroupAction"
                        onClick={() => acceptGrounded(group)}>
                        Accept {group.groundedProposed} grounded
                      </button>
                    ) : null}
                  </div>
                  {group.entries.map(entry => (
                    <button
                      key={entry.id}
                      type="button"
                      role="option"
                      aria-selected={entry.id === effectiveSelectedId}
                      className={
                        'rwr-Row' +
                        (entry.id === effectiveSelectedId ? ' rwr-RowOn' : '')
                      }
                      data-tool-name={entry.tool.qualifiedName}
                      data-status={entry.status}
                      onClick={() => setSelectedId(entry.id)}>
                      <span className="rwr-RowMain">
                        <span className="rwr-RowName">
                          {entry.tool.qualifiedName}
                        </span>
                        <span className="rwr-RowDesc">
                          {entry.tool.description}
                        </span>
                      </span>
                      <SafetyTag safety={entry.tool.safety} />
                      <span className="rwr-Status">
                        {entry.needsAttention ? (
                          <Icon d={ICON_WARN} className="rwr-warn" />
                        ) : null}
                        <StatusTag status={entry.status} />
                      </span>
                    </button>
                  ))}
                </React.Fragment>
              ))}
            </div>
            <div className="rwr-ListFoot">
              <span>
                {pluralize(visible.length, 'tool')} in{' '}
                {pluralize(groups.length, groupLabel(groupBy))}
              </span>
              <span className="rwr-Kbds" aria-hidden="true">
                <span className="rwr-Kbd">A</span> accept{' '}
                <span className="rwr-Kbd">R</span> reject
              </span>
            </div>
          </div>

          <div className="rwr-Form">
            {selected === null || shown === null ? (
              <div className="rwr-FormScroll">
                <div className="rwr-Note">Select a tool to review it.</div>
              </div>
            ) : selected.status === 'exported' ? (
              <div className="rwr-FormScroll">
                <div className="rwr-FormHead">
                  <span className="rwr-FormName">{shown.qualifiedName}</span>
                  <StatusTag status="exported" />
                  <span className="rwr-FormNav">{selectedGroupPosition}</span>
                </div>
                <EvidenceCard
                  entry={selected}
                  now={now}
                  onOpenSource={onOpenSource}
                  editor={editor}
                  sourceRoot={sourceRoot}
                />
                <div className="rwr-Note">
                  {selected.live
                    ? 'This tool is registered in the page right now. Edit it in source.'
                    : 'This tool is already in source.'}
                </div>
                <dl className="rwr-ReadOnly">
                  <dt>Description</dt>
                  <dd>{shown.description}</dd>
                  <dt>Safety</dt>
                  <dd>
                    <SafetyTag safety={shown.safety} />
                  </dd>
                  <dt>Lifetime</dt>
                  <dd>{shown.lifetime}</dd>
                  <dt>Schema</dt>
                  <dd>
                    {shown.inputSchema == null ? (
                      'none'
                    ) : (
                      <pre className="rwr-Pre">
                        {JSON.stringify(shown.inputSchema, null, 2)}
                      </pre>
                    )}
                  </dd>
                </dl>
              </div>
            ) : (
              <>
                <div className="rwr-FormScroll">
                  <div className="rwr-FormHead">
                    <span className="rwr-FormName">{shown.qualifiedName}</span>
                    <StatusTag status={selected.status} />
                    <span className="rwr-FormNav">{selectedGroupPosition}</span>
                  </div>
                  <EvidenceCard
                    entry={selected}
                    now={now}
                    onOpenSource={onOpenSource}
                    editor={editor}
                    sourceRoot={sourceRoot}
                  />
                  <label className="rwr-Field">
                    <span className="rwr-Label">Name</span>
                    <input
                      className="rwr-Input rwr-Mono"
                      value={shown.name}
                      onChange={event =>
                        updateDraft(selected.id, {
                          name: event.currentTarget.value,
                        })
                      }
                    />
                    {shown.scopePath.length > 0 ? (
                      <span className="rwr-Hint">
                        Agents see {shown.qualifiedName}
                      </span>
                    ) : null}
                  </label>
                  <label className="rwr-Field">
                    <span className="rwr-Label">Description</span>
                    <textarea
                      className="rwr-Textarea"
                      value={shown.description}
                      onChange={event =>
                        updateDraft(selected.id, {
                          description: event.currentTarget.value,
                        })
                      }
                    />
                  </label>
                  <div className="rwr-Two">
                    <div className="rwr-Field">
                      <span className="rwr-Label">Safety</span>
                      <Segmented
                        ariaLabel="Safety"
                        value={shown.safety}
                        options={SAFETY_ORDER}
                        labels={safetyLabel}
                        onChange={(safety: Safety) =>
                          updateDraft(selected.id, {safety})
                        }
                      />
                      <span className="rwr-Hint">
                        readOnlyHint · consequentialHint
                      </span>
                    </div>
                    <div className="rwr-Field">
                      <span className="rwr-Label">Lifetime</span>
                      <Segmented
                        ariaLabel="Lifetime"
                        value={shown.lifetime}
                        options={LIFETIME_ORDER}
                        labels={(lifetime: Lifetime) => lifetime}
                        onChange={(lifetime: Lifetime) =>
                          updateDraft(selected.id, {lifetime})
                        }
                      />
                    </div>
                  </div>
                  <SchemaEditor
                    key={selected.id}
                    initialRows={schemaRows(shown.inputSchema)}
                    flags={propertyFlags(selected.original.evidence)}
                    onChange={rows =>
                      updateDraft(selected.id, {
                        inputSchema: schemaFromRows(rows),
                      })
                    }
                  />
                </div>
                <div className="rwr-FormFoot">
                  {selected.decision !== null ? (
                    <>
                      <button
                        type="button"
                        className="rwr-Btn rwr-Ghost"
                        onClick={() => undecide(selected.id)}>
                        Undo {selected.decision.status}
                      </button>
                      {selectedDraft !== null ? (
                        <button
                          type="button"
                          className="rwr-Btn rwr-Primary"
                          onClick={() =>
                            decide(
                              selected.id,
                              selected.decision != null
                                ? selected.decision.status
                                : 'accepted',
                              false,
                            )
                          }>
                          Save changes
                        </button>
                      ) : null}
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="rwr-Btn"
                        onClick={() => decide(selected.id, 'rejected', true)}>
                        Reject
                      </button>
                      <button
                        type="button"
                        className="rwr-Btn rwr-Primary"
                        onClick={() => decide(selected.id, 'accepted', true)}>
                        Accept and next
                        <Icon d={ICON_NEXT} />
                      </button>
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        </div>

        <div className="rwr-Foot">
          <span className="rwr-FootNote">
            {counts.accepted} accepted · {remaining} still to review
          </span>
          <div className="rwr-Spacer" />
          <button
            type="button"
            className="rwr-Btn"
            disabled={counts.accepted === 0}
            onClick={handleExport}>
            Export {counts.accepted} accepted
            <Icon d={ICON_EXPORT} />
          </button>
        </div>
      </div>
    </div>
  );
}
