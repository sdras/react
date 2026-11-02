/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

'use strict';

// The Anthropic synthesize provider: one Messages API request per batch of
// candidates, with a JSON schema on the output so the reply parses without
// coaxing. Uses the official SDK; the client can be injected for tests.
//
// Environment: ANTHROPIC_API_KEY (or an `ant auth login` profile, which the
// SDK picks up on its own), REACT_WEBMCP_ANTHROPIC_MODEL to override the
// model, REACT_WEBMCP_ANTHROPIC_FALLBACKS=off to drop the server-side
// refusal fallback.

import type {ToolProposal} from '../../src/ReactWebMCPProposalTypes';
import type {SynthesizeContext, SynthesizeProvider} from '../synthesize.flow';
import type {LLMRequest} from './llm.flow';

const {synthesizeWithModel} = require('./llm.flow');

const DEFAULT_MODEL = 'claude-opus-5-5';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export type AnthropicProviderOptions = {
  // An @anthropic-ai/sdk client (or a test double with the same shape).
  client?: any,
  apiKey?: string,
  model?: string,
  env?: {[string]: string | void},
  warn?: (message: string) => void,
  batchSize?: number,
};

function loadClient(apiKey: ?string): any {
  let sdk;
  try {
    // $FlowFixMe[untyped-import]: optional dev dependency.
    sdk = require('@anthropic-ai/sdk');
  } catch (error) {
    throw new Error(
      'The anthropic provider needs @anthropic-ai/sdk. Install it (it is a ' +
        'devDependency of react-webmcp; run `yarn install --ignore-engines`) ' +
        'and set ANTHROPIC_API_KEY or sign in with `ant auth login`.',
    );
  }
  const Anthropic = sdk.default != null ? sdk.default : sdk;
  return apiKey != null && apiKey !== ''
    ? new Anthropic({apiKey})
    : new Anthropic();
}

function createAnthropicProvider(
  options: AnthropicProviderOptions = {},
): SynthesizeProvider {
  const env = options.env != null ? options.env : process.env;
  const model =
    options.model != null && options.model !== ''
      ? options.model
      : env.REACT_WEBMCP_ANTHROPIC_MODEL != null &&
          env.REACT_WEBMCP_ANTHROPIC_MODEL !== ''
        ? env.REACT_WEBMCP_ANTHROPIC_MODEL
        : DEFAULT_MODEL;
  const useFallbacks = env.REACT_WEBMCP_ANTHROPIC_FALLBACKS !== 'off';
  const warn: (message: string) => void =
    options.warn != null
      ? options.warn
      : (message: string) => {
          process.stderr.write(message + '\n');
        };
  let client = options.client;

  async function complete(request: LLMRequest): Promise<string> {
    if (client == null) {
      client = loadClient(
        options.apiKey != null ? options.apiKey : env.ANTHROPIC_API_KEY,
      );
    }
    const params: {[string]: mixed} = {
      model,
      max_tokens: 16000,
      system: request.system,
      messages: [{role: 'user', content: request.prompt}],
      output_config: {
        effort: 'medium',
        format: {type: 'json_schema', schema: request.schema},
      },
    };
    if (useFallbacks) {
      // A policy decline re-runs the request on a fallback model server-side.
      params.betas = [FALLBACK_BETA];
      params.fallbacks = 'default';
    }
    const response = await client.beta.messages.create(params);
    if (response.stop_reason === 'refusal') {
      const details = response.stop_details;
      throw new Error(
        'the model declined the request' +
          (details != null && typeof details.explanation === 'string'
            ? `: ${details.explanation}`
            : ''),
      );
    }
    if (response.stop_reason === 'max_tokens') {
      throw new Error('the model response was cut off; try a smaller batch');
    }
    const content = Array.isArray(response.content) ? response.content : [];
    const textBlock = content.find(
      block => block != null && block.type === 'text',
    );
    if (textBlock == null || typeof textBlock.text !== 'string') {
      throw new Error('the model response has no text block');
    }
    return textBlock.text;
  }

  return {
    name: `anthropic:${model}`,
    synthesize(
      proposals: Array<ToolProposal>,
      context: SynthesizeContext,
    ): Promise<Array<ToolProposal>> {
      return synthesizeWithModel(proposals, context, {
        name: 'anthropic',
        complete,
        warn,
        batchSize: options.batchSize,
      });
    },
  };
}

module.exports = {DEFAULT_MODEL, FALLBACK_BETA, createAnthropicProvider};
