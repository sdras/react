/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

'use strict';

// What the network providers share: batching, the prompt, the response schema,
// and validation of what comes back. A provider only has to turn one
// `LLMRequest` into the JSON text the model produced; everything that touches
// proposals lives here so the two providers cannot drift apart.

const fs = require('fs');
const path = require('path');

import type {ToolProposal} from '../../src/ReactWebMCPProposalTypes';
import type {SynthesizeContext} from '../synthesize.flow';

export type Suggestion = {
  id: string,
  name: string,
  description: string,
};

export type LLMRequest = {
  system: string,
  prompt: string,
  // JSON Schema for the whole response: {suggestions: Suggestion[]}.
  schema: {[string]: mixed},
};

export type ModelOptions = {
  // Which provider, for the `provider` field and messages.
  name: string,
  complete: (request: LLMRequest) => Promise<string>,
  warn: (message: string) => void,
  // How many proposals go into one request.
  batchSize?: number,
  // Lines of source shown on each side of the binding.
  excerptRadius?: number,
};

const DEFAULT_BATCH_SIZE = 12;
const DEFAULT_EXCERPT_RADIUS = 20;
const MAX_NAME_LENGTH = 30;
const MAX_DESCRIPTION_LENGTH = 500;
const NAME_PATTERN = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

const SUGGESTIONS_SCHEMA: {[string]: mixed} = {
  type: 'object',
  properties: {
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: {type: 'string'},
          name: {type: 'string'},
          description: {type: 'string'},
        },
        required: ['id', 'name', 'description'],
        additionalProperties: false,
      },
    },
  },
  required: ['suggestions'],
  additionalProperties: false,
};

const SYSTEM_PROMPT: string = [
  'You name and describe WebMCP agent tools for a React app. Each candidate',
  'below is a handler or form that inference found in the source, with the',
  'code around it. For every candidate, return a tool name and a description',
  'that an AI agent will read when deciding whether to call the tool.',
  '',
  'Rules:',
  '- Keep the id exactly as given. Return one suggestion per candidate.',
  '- name: snake_case, a verb then an object (add_item, list_orders),',
  '  at most 30 characters, no scope prefix (it is added separately).',
  '- description: one or two plain sentences, at most 200 characters, that',
  '  say what the tool does for the user, what input it needs, and what it',
  '  returns or changes. Mention irreversible effects. Do not mention React,',
  '  components, state, handlers, or implementation details.',
  '- Do not invent capabilities the code does not have. If the handler only',
  '  toggles UI state, say so plainly.',
].join('\n');

function batchProposals(
  proposals: Array<ToolProposal>,
  size: number,
): Array<Array<ToolProposal>> {
  const batches: Array<Array<ToolProposal>> = [];
  for (let i = 0; i < proposals.length; i += size) {
    batches.push(proposals.slice(i, i + size));
  }
  return batches;
}

// The source around a binding, numbered, or null when the file is missing.
function readExcerpt(
  sourceDir: string,
  proposal: ToolProposal,
  radius: number,
): string | null {
  const file = path.resolve(sourceDir, proposal.binding.file);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return null;
  }
  const lines = text.split('\n');
  const center = Math.max(1, proposal.binding.line);
  const start = Math.max(1, center - radius);
  const end = Math.min(lines.length, center + radius);
  const width = end.toString().length;
  const out: Array<string> = [];
  for (let line = start; line <= end; line++) {
    const number = line.toString().padStart(width, ' ');
    out.push(`${line === center ? '>' : ' '}${number}| ${lines[line - 1]}`);
  }
  return out.join('\n');
}

function describeCandidate(
  proposal: ToolProposal,
  excerpt: string | null,
): string {
  const schema = proposal.inputSchema;
  const params =
    schema == null
      ? 'none'
      : Object.keys(schema.properties)
          .map(name => {
            const property = schema.properties[name];
            const required = schema.required.indexOf(name) !== -1;
            return `${name}: ${property.type}${required ? '' : '?'}`;
          })
          .join(', ');
  const header = [
    `id: ${proposal.id}`,
    `current name: ${proposal.name}`,
    `scope: ${proposal.scopePath.length === 0 ? '(none)' : proposal.scopePath.join('/')}`,
    `route: ${proposal.route}`,
    `safety: ${proposal.safety}`,
    `binding: ${proposal.binding.kind} ${
      proposal.binding.component != null ? proposal.binding.component : ''
    }${proposal.binding.handler != null ? '.' + proposal.binding.handler : ''} (${
      proposal.binding.file
    }:${proposal.binding.line})`,
    `parameters: ${params}`,
  ];
  return (
    header.join('\n') +
    '\nsource:\n' +
    (excerpt == null ? '(unavailable)' : excerpt)
  );
}

function buildRequest(
  batch: Array<ToolProposal>,
  context: SynthesizeContext,
  radius: number,
): LLMRequest {
  const parts = batch.map((proposal, index) => {
    const excerpt = readExcerpt(context.source.dir, proposal, radius);
    return `--- candidate ${index + 1} of ${batch.length} ---\n${describeCandidate(
      proposal,
      excerpt,
    )}`;
  });
  const prompt =
    `Source directory: ${context.source.dir}\n\n` +
    parts.join('\n\n') +
    '\n\nReturn {"suggestions": [...]} with one entry per candidate id.';
  return {system: SYSTEM_PROMPT, prompt, schema: SUGGESTIONS_SCHEMA};
}

function parseSuggestions(text: string): Array<Suggestion> {
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`the model did not return JSON: ${error.message}`);
  }
  if (parsed == null || !Array.isArray(parsed.suggestions)) {
    throw new Error('the model response has no "suggestions" array');
  }
  const suggestions: Array<Suggestion> = [];
  for (let i = 0; i < parsed.suggestions.length; i++) {
    const item = parsed.suggestions[i];
    if (
      item != null &&
      typeof item.id === 'string' &&
      typeof item.name === 'string' &&
      typeof item.description === 'string'
    ) {
      suggestions.push({
        id: item.id,
        name: item.name.trim(),
        description: item.description.trim(),
      });
    }
  }
  return suggestions;
}

// Why a suggestion cannot be used as-is, or null when it is fine.
function validateSuggestion(suggestion: Suggestion): string | null {
  if (suggestion.name === '' || !NAME_PATTERN.test(suggestion.name)) {
    return `name "${suggestion.name}" is not snake_case`;
  }
  if (suggestion.name.length > MAX_NAME_LENGTH) {
    return `name "${suggestion.name}" is longer than ${MAX_NAME_LENGTH} characters`;
  }
  if (suggestion.description === '') {
    return 'description is empty';
  }
  if (suggestion.description.length > MAX_DESCRIPTION_LENGTH) {
    return `description is longer than ${MAX_DESCRIPTION_LENGTH} characters`;
  }
  return null;
}

function applySuggestions(
  batch: Array<ToolProposal>,
  suggestions: Array<Suggestion>,
  providerName: string,
  warn: (message: string) => void,
): Array<ToolProposal> {
  const byId: Map<string, Suggestion> = new Map();
  for (let i = 0; i < suggestions.length; i++) {
    byId.set(suggestions[i].id, suggestions[i]);
  }
  return batch.map((proposal): ToolProposal => {
    const suggestion = byId.get(proposal.id);
    if (suggestion === undefined) {
      warn(`${providerName}: no suggestion for ${proposal.id}; kept as is`);
      return proposal;
    }
    const problem = validateSuggestion(suggestion);
    if (problem !== null) {
      warn(`${providerName}: ${proposal.id}: ${problem}; kept as is`);
      return proposal;
    }
    return {
      ...proposal,
      name: suggestion.name,
      description: suggestion.description,
    };
  });
}

async function synthesizeWithModel(
  proposals: Array<ToolProposal>,
  context: SynthesizeContext,
  options: ModelOptions,
): Promise<Array<ToolProposal>> {
  const batchSize =
    options.batchSize != null && options.batchSize > 0
      ? options.batchSize
      : DEFAULT_BATCH_SIZE;
  const radius =
    options.excerptRadius != null
      ? options.excerptRadius
      : DEFAULT_EXCERPT_RADIUS;
  const batches = batchProposals(proposals, batchSize);
  const result: Array<ToolProposal> = [];
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const request = buildRequest(batch, context, radius);
    const text = await options.complete(request);
    const suggestions = parseSuggestions(text);
    const applied = applySuggestions(
      batch,
      suggestions,
      options.name,
      options.warn,
    );
    for (let j = 0; j < applied.length; j++) {
      result.push(applied[j]);
    }
  }
  return result;
}

module.exports = {
  SUGGESTIONS_SCHEMA,
  SYSTEM_PROMPT,
  applySuggestions,
  batchProposals,
  buildRequest,
  parseSuggestions,
  readExcerpt,
  synthesizeWithModel,
  validateSuggestion,
};
