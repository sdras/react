/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {Lifetime, Safety} from './ReactWebMCPTypes';

// The shape of a proposed agent tool, as written by the inference assistant
// (`packages/react-webmcp/infer`) into `tools.proposals.json` and read by the
// review overlay (`react-webmcp/unstable_review`). It reuses the field names
// of `ToolRecord` so a proposal and a live tool diff cleanly, and adds the
// code binding and the grounding evidence a reviewer needs.

export type ProposalStatus =
  // Inferred, waiting for a decision.
  | 'proposed'
  // The reviewer accepted it (possibly with edits); not in source yet.
  | 'accepted'
  // The reviewer rejected it.
  | 'rejected'
  // Already implemented in source (an existing useWebMCPTool call or <Tool>),
  // or currently registered in the page.
  | 'exported';

export type EvidenceLevel = 'ok' | 'warn' | 'bad' | 'pending';

export type EvidenceCheck =
  // The handler or form the tool would call exists at the recorded location.
  | 'binding'
  // The proposed input schema agrees with what the handler reads.
  | 'schema'
  // Calling the handler in a running page changed state (recorded by trace).
  | 'replay'
  // The owning component was mounted during a traced journey.
  | 'mounted'
  // A user journey (CUJ) exercised this action.
  | 'trace';

export type SourceLocation = {
  // Path relative to the directory `infer extract` was pointed at.
  file: string,
  line: number,
  column: number,
};

export type ProposalEvidence = {
  check: EvidenceCheck,
  level: EvidenceLevel,
  // One line, as shown in the review overlay, e.g. "binding addItem exists".
  summary: string,
  location?: SourceLocation | null,
  // For schema findings about one parameter, its name (e.g. "quantity").
  property?: string | null,
};

export type ProposalBindingKind =
  // A function inside a component that mutates state, fetches, or is wired to
  // an event prop.
  | 'handler'
  // A <form onSubmit> whose named inputs became the schema.
  | 'form'
  // An existing useWebMCPTool call.
  | 'existing-hook'
  // An existing <Tool> element in a <ToolTree>.
  | 'existing-tool-element';

export type ProposalBinding = {
  kind: ProposalBindingKind,
  file: string,
  line: number,
  column: number,
  // The component that owns the handler, when it is inside one.
  component: string | null,
  // The handler's name (null for anonymous functions).
  handler: string | null,
  // The handler's parameter names, in order, so `infer emit` can map schema
  // properties onto a call. For a form binding these are the input names.
  params: Array<string>,
  // How the handler takes its input: positional parameters, one destructured
  // object (`({sku, quantity}) => …`), or no parameters at all.
  paramStyle: 'positional' | 'object' | 'none',
};

export type ProposalSchemaProperty = {
  type: string,
  description: string,
};

export type ProposalInputSchema = {
  type: 'object',
  properties: {[name: string]: ProposalSchemaProperty},
  required: Array<string>,
};

export type ToolProposal = {
  // Stable across runs: derived from the binding (file, component, handler).
  id: string,
  name: string,
  qualifiedName: string,
  scopePath: Array<string>,
  // The grouping key the overlay shows first, e.g. "/cart". Derived from the
  // file path when the app's routing is not visible statically.
  route: string,
  description: string,
  safety: Safety,
  lifetime: Lifetime,
  inputSchema: ProposalInputSchema | null,
  binding: ProposalBinding,
  evidence: Array<ProposalEvidence>,
  status: ProposalStatus,
  // ISO 8601.
  inferredAt: string,
  // Which synthesize provider wrote the description, when one ran.
  provider: string | null,
};

export type ProposalsFile = {
  version: 1,
  generatedAt: string,
  source: {
    dir: string,
    files: Array<string>,
  },
  proposals: Array<ToolProposal>,
};

// The reviewer's edits to one proposal. Only fields that changed are present.
export type ProposalEdits = {
  name?: string,
  description?: string,
  safety?: Safety,
  lifetime?: Lifetime,
  inputSchema?: ProposalInputSchema | null,
};

export type ReviewDecision = {
  id: string,
  status: 'accepted' | 'rejected',
  edits: ProposalEdits,
  // ISO 8601.
  decidedAt: string,
};

// What "Export accepted" hands to `infer emit`: the accepted proposals with
// their edits already applied, plus the ids the reviewer rejected so a rerun
// of extract can leave them alone.
export type ReviewExport = {
  version: 1,
  exportedAt: string,
  accepted: Array<ToolProposal>,
  rejected: Array<string>,
};
