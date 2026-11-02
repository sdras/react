/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

'use strict';

// `infer synthesize`: rewrites the placeholder names and descriptions that
// `extract` produced into ones an agent can act on. The work is delegated to
// a provider: the deterministic `fixture` provider (no network); the
// `anthropic`, `gemini` and `openai` providers in ./providers, which show the
// model the source around each binding and ask for a name and description
// (`openai` speaks the chat completions wire format, so it also covers local
// and hosted servers such as Ollama or vLLM behind --base-url); or a module of
// the user's own, named by path. All of them implement `SynthesizeProvider`,
// and the model is never baked in: --model overrides every provider's default.

import type {
  ProposalsFile,
  ToolProposal,
} from '../src/ReactWebMCPProposalTypes';

export type SynthesizeContext = {
  source: {dir: string, files: Array<string>},
  // ISO 8601; when the synthesize run happened.
  now: string,
};

export type SynthesizeProvider = {
  name: string,
  // Receives only the proposals still in `status: 'proposed'` and returns them
  // rewritten, in any order. Ids must be preserved; everything else may change.
  synthesize: (
    proposals: Array<ToolProposal>,
    context: SynthesizeContext,
  ) => Promise<Array<ToolProposal>>,
};

export type ProviderOptions = {
  // --model: overrides the provider's default (or required, for openai).
  model?: ?string,
  // --base-url: the endpoint for openai-compatible servers.
  baseURL?: ?string,
  // Where a provider module path is resolved from (default process.cwd()).
  cwd?: ?string,
  warn?: (message: string) => void,
};

const KNOWN_PROVIDERS = ['fixture', 'anthropic', 'gemini', 'openai'];
const DEFAULT_PROVIDER = 'fixture';

function resolveProviderName(
  flag: ?string,
  env: {[string]: string | void},
): string {
  if (flag != null && flag !== '') {
    return flag;
  }
  const fromEnv = env.REACT_WEBMCP_LLM;
  if (fromEnv != null && fromEnv !== '') {
    return fromEnv;
  }
  return DEFAULT_PROVIDER;
}

function getProvider(
  name: string,
  options: ProviderOptions = {},
): SynthesizeProvider {
  const model =
    options.model != null && options.model !== '' ? options.model : undefined;
  const baseURL =
    options.baseURL != null && options.baseURL !== ''
      ? options.baseURL
      : undefined;
  if (name === 'fixture') {
    return require('./providers/fixture.flow').createFixtureProvider();
  }
  if (name === 'anthropic') {
    return require('./providers/anthropic.flow').createAnthropicProvider({
      model,
      warn: options.warn,
    });
  }
  if (name === 'gemini') {
    return require('./providers/gemini.flow').createGeminiProvider({
      model,
      warn: options.warn,
    });
  }
  if (name === 'openai') {
    return require('./providers/openai.flow').createOpenAIProvider({
      model,
      baseURL,
      warn: options.warn,
    });
  }
  const {
    isProviderPath,
    loadProviderModule,
  } = require('./providers/module.flow');
  if (isProviderPath(name)) {
    return loadProviderModule(name, {
      cwd: options.cwd != null ? options.cwd : process.cwd(),
      model,
      baseURL,
      warn: options.warn,
    });
  }
  throw new Error(
    `unknown provider "${name}"; expected one of ${KNOWN_PROVIDERS.join(
      ', ',
    )}, or the path of a provider module such as ./my-provider.js`,
  );
}

function qualify(scopePath: Array<string>, name: string): string {
  return scopePath.concat(name).join('_');
}

async function synthesizeProposals(
  file: ProposalsFile,
  provider: SynthesizeProvider,
  options?: {now?: string},
): Promise<{file: ProposalsFile, touched: Array<ToolProposal>}> {
  const now =
    options != null && options.now != null
      ? options.now
      : new Date().toISOString();
  const pending = file.proposals.filter(
    proposal => proposal.status === 'proposed',
  );
  if (pending.length === 0) {
    return {file, touched: []};
  }
  const rewritten = await provider.synthesize(
    pending.map(proposal => ({...proposal})),
    {source: file.source, now},
  );
  const byId: Map<string, ToolProposal> = new Map();
  for (let i = 0; i < rewritten.length; i++) {
    const proposal = rewritten[i];
    if (proposal != null && typeof proposal.id === 'string') {
      byId.set(proposal.id, proposal);
    }
  }
  const touched: Array<ToolProposal> = [];
  const proposals = file.proposals.map(original => {
    if (original.status !== 'proposed') {
      return original;
    }
    const result = byId.get(original.id);
    if (result === undefined) {
      return original;
    }
    const name =
      typeof result.name === 'string' && result.name !== ''
        ? result.name
        : original.name;
    const description =
      typeof result.description === 'string'
        ? result.description
        : original.description;
    const next: ToolProposal = {
      ...original,
      name,
      qualifiedName: qualify(original.scopePath, name),
      description,
      provider: provider.name,
    };
    touched.push(next);
    return next;
  });
  return {file: {...file, proposals}, touched};
}

module.exports = {
  DEFAULT_PROVIDER,
  KNOWN_PROVIDERS,
  getProvider,
  resolveProviderName,
  synthesizeProposals,
};
