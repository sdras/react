/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

'use strict';

// A synthesize provider for any endpoint that speaks the OpenAI chat
// completions wire format: OpenAI itself, and local or hosted servers such as
// Ollama, vLLM, LM Studio, Groq, Together or OpenRouter behind `--base-url`.
// This is how a team brings its own model without writing a provider module.
//
// Environment: OPENAI_API_KEY (optional for local servers), OPENAI_BASE_URL
// (default https://api.openai.com/v1), REACT_WEBMCP_OPENAI_MODEL (or
// --model; there is no default because the right model depends on the
// server), REACT_WEBMCP_OPENAI_JSON=schema|object|none to choose how the JSON
// response is requested (default schema; older servers only accept object).

import type {ToolProposal} from '../../src/ReactWebMCPProposalTypes';
import type {SynthesizeContext, SynthesizeProvider} from '../synthesize.flow';
import type {LLMRequest} from './llm.flow';

const {synthesizeWithModel} = require('./llm.flow');

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const RESPONSE_FORMATS = ['schema', 'object', 'none'];

export type OpenAIResponseFormat = 'schema' | 'object' | 'none';

export type OpenAIProviderOptions = {
  fetch?: any,
  apiKey?: string,
  baseURL?: string,
  model?: string,
  responseFormat?: OpenAIResponseFormat,
  env?: {[string]: string | void},
  warn?: (message: string) => void,
  batchSize?: number,
};

function pick(...values: Array<?string>): string {
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (value != null && value !== '') {
      return value;
    }
  }
  return '';
}

function hostLabel(baseURL: string): string {
  try {
    return new URL(baseURL).host;
  } catch (error) {
    return baseURL;
  }
}

// Models without a JSON mode tend to wrap the object in a code fence.
function stripFence(text: string): string {
  const match = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(text);
  return match != null ? match[1] : text;
}

function createOpenAIProvider(
  options: OpenAIProviderOptions = {},
): SynthesizeProvider {
  const env = options.env != null ? options.env : process.env;
  const model = pick(
    options.model,
    env.REACT_WEBMCP_OPENAI_MODEL,
    env.OPENAI_MODEL,
  );
  const baseURL = pick(
    options.baseURL,
    env.OPENAI_BASE_URL,
    DEFAULT_BASE_URL,
  ).replace(/\/+$/, '');
  const apiKey = pick(options.apiKey, env.OPENAI_API_KEY);
  const responseFormat = pick(
    options.responseFormat,
    env.REACT_WEBMCP_OPENAI_JSON,
    'schema',
  );
  if (RESPONSE_FORMATS.indexOf(responseFormat) === -1) {
    throw new Error(
      `REACT_WEBMCP_OPENAI_JSON must be one of ${RESPONSE_FORMATS.join(
        ', ',
      )}, not "${responseFormat}"`,
    );
  }
  const warn: (message: string) => void =
    options.warn != null
      ? options.warn
      : (message: string) => {
          process.stderr.write(message + '\n');
        };
  const fetchImpl =
    options.fetch != null ? options.fetch : (globalThis as any).fetch;
  const host = hostLabel(baseURL);
  const label = baseURL === DEFAULT_BASE_URL ? 'openai' : `openai@${host}`;

  async function complete(request: LLMRequest): Promise<string> {
    if (model === '') {
      throw new Error(
        'The openai provider needs a model: pass --model <id> or set ' +
          'REACT_WEBMCP_OPENAI_MODEL (the right one depends on the server).',
      );
    }
    if (typeof fetchImpl !== 'function') {
      throw new Error('The openai provider needs a global fetch (Node 18+).');
    }
    const body: {[string]: mixed} = {
      model,
      messages: [
        {role: 'system', content: request.system},
        {role: 'user', content: request.prompt},
      ],
    };
    if (responseFormat === 'schema') {
      body.response_format = {
        type: 'json_schema',
        json_schema: {
          name: 'suggestions',
          schema: request.schema,
          strict: true,
        },
      };
    } else if (responseFormat === 'object') {
      body.response_format = {type: 'json_object'};
    }
    const headers: {[string]: string} = {'content-type': 'application/json'};
    if (apiKey !== '') {
      headers.authorization = `Bearer ${apiKey}`;
    }
    const response = await fetchImpl(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      let detail = '';
      try {
        detail = await response.text();
      } catch (error) {
        // The status is enough.
      }
      let hint = '';
      if (
        response.status === 400 &&
        responseFormat === 'schema' &&
        /response_format|json_schema/i.test(detail)
      ) {
        hint =
          ' (this server may not support json_schema responses; set ' +
          'REACT_WEBMCP_OPENAI_JSON=object or none)';
      }
      throw new Error(
        `${host} returned HTTP ${response.status}${
          detail !== '' ? `: ${detail.slice(0, 300)}` : ''
        }${hint}`,
      );
    }
    const json: any = await response.json();
    const choice =
      json != null && Array.isArray(json.choices) ? json.choices[0] : null;
    const message = choice != null ? choice.message : null;
    if (message != null && typeof message.refusal === 'string') {
      throw new Error(`the model declined the request: ${message.refusal}`);
    }
    if (choice != null && choice.finish_reason === 'length') {
      throw new Error('the model response was cut off; try a smaller batch');
    }
    let content = message != null ? message.content : null;
    if (Array.isArray(content)) {
      content = content
        .map(part =>
          part != null && typeof part.text === 'string' ? part.text : '',
        )
        .join('');
    }
    if (typeof content !== 'string' || content === '') {
      throw new Error(`${host} returned no message content`);
    }
    return stripFence(content);
  }

  return {
    name: `${label}:${model}`,
    synthesize(
      proposals: Array<ToolProposal>,
      context: SynthesizeContext,
    ): Promise<Array<ToolProposal>> {
      return synthesizeWithModel(proposals, context, {
        name: label,
        complete,
        warn,
        batchSize: options.batchSize,
      });
    },
  };
}

module.exports = {DEFAULT_BASE_URL, createOpenAIProvider, stripFence};
