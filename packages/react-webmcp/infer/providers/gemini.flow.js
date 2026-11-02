/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

'use strict';

// The Gemini synthesize provider, over the generateContent REST endpoint with
// a JSON response schema. `fetch` can be injected for tests.
//
// Environment: GEMINI_API_KEY (or GOOGLE_API_KEY), REACT_WEBMCP_GEMINI_MODEL
// to override the model.

import type {ToolProposal} from '../../src/ReactWebMCPProposalTypes';
import type {SynthesizeContext, SynthesizeProvider} from '../synthesize.flow';
import type {LLMRequest} from './llm.flow';

const {synthesizeWithModel} = require('./llm.flow');

const DEFAULT_MODEL = 'gemini-2.5-flash';
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

export type GeminiProviderOptions = {
  fetch?: any,
  apiKey?: string,
  model?: string,
  env?: {[string]: string | void},
  warn?: (message: string) => void,
  batchSize?: number,
};

// Gemini's responseSchema is an OpenAPI subset: no additionalProperties.
function toGeminiSchema(schema: mixed): mixed {
  if (Array.isArray(schema)) {
    return schema.map(toGeminiSchema);
  }
  if (schema == null || typeof schema !== 'object') {
    return schema;
  }
  const out: {[string]: mixed} = {};
  for (const key in schema) {
    if (key === 'additionalProperties') {
      continue;
    }
    out[key] = toGeminiSchema(schema[key]);
  }
  return out;
}

function createGeminiProvider(
  options: GeminiProviderOptions = {},
): SynthesizeProvider {
  const env = options.env != null ? options.env : process.env;
  const model =
    options.model != null && options.model !== ''
      ? options.model
      : env.REACT_WEBMCP_GEMINI_MODEL != null &&
          env.REACT_WEBMCP_GEMINI_MODEL !== ''
        ? env.REACT_WEBMCP_GEMINI_MODEL
        : DEFAULT_MODEL;
  const apiKey =
    options.apiKey != null && options.apiKey !== ''
      ? options.apiKey
      : env.GEMINI_API_KEY != null && env.GEMINI_API_KEY !== ''
        ? env.GEMINI_API_KEY
        : env.GOOGLE_API_KEY;
  const warn: (message: string) => void =
    options.warn != null
      ? options.warn
      : (message: string) => {
          process.stderr.write(message + '\n');
        };
  const fetchImpl =
    options.fetch != null ? options.fetch : (globalThis as any).fetch;

  async function complete(request: LLMRequest): Promise<string> {
    if (apiKey == null || apiKey === '') {
      throw new Error(
        'The gemini provider needs GEMINI_API_KEY in the environment.',
      );
    }
    if (typeof fetchImpl !== 'function') {
      throw new Error('The gemini provider needs a global fetch (Node 18+).');
    }
    const url = `${ENDPOINT}/${encodeURIComponent(model)}:generateContent`;
    const body = {
      systemInstruction: {parts: [{text: request.system}]},
      contents: [{role: 'user', parts: [{text: request.prompt}]}],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: toGeminiSchema(request.schema),
      },
    };
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      let detail = '';
      try {
        detail = await response.text();
      } catch (error) {
        // The status is enough.
      }
      throw new Error(
        `Gemini returned HTTP ${response.status}${detail !== '' ? `: ${detail.slice(0, 300)}` : ''}`,
      );
    }
    const json: any = await response.json();
    const candidate =
      json != null && Array.isArray(json.candidates)
        ? json.candidates[0]
        : null;
    const parts =
      candidate != null && candidate.content != null
        ? candidate.content.parts
        : null;
    if (!Array.isArray(parts) || parts.length === 0) {
      const reason =
        candidate != null && typeof candidate.finishReason === 'string'
          ? ` (finishReason ${candidate.finishReason})`
          : '';
      throw new Error(`Gemini returned no content${reason}`);
    }
    return parts
      .map(part =>
        part != null && typeof part.text === 'string' ? part.text : '',
      )
      .join('');
  }

  return {
    name: `gemini:${model}`,
    synthesize(
      proposals: Array<ToolProposal>,
      context: SynthesizeContext,
    ): Promise<Array<ToolProposal>> {
      return synthesizeWithModel(proposals, context, {
        name: 'gemini',
        complete,
        warn,
        batchSize: options.batchSize,
      });
    },
  };
}

module.exports = {DEFAULT_MODEL, createGeminiProvider, toGeminiSchema};
