/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails react-core
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const llm = require('../providers/llm.flow');
const {createAnthropicProvider} = require('../providers/anthropic.flow');
const {
  createGeminiProvider,
  toGeminiSchema,
} = require('../providers/gemini.flow');
const {createOpenAIProvider, stripFence} = require('../providers/openai.flow');
const {getProvider, synthesizeProposals} = require('../synthesize.flow');

let sourceDir;

function proposal(overrides) {
  return {
    id: 'Cart.js#Cart.addItem',
    name: 'add_item',
    qualifiedName: 'cart_add_item',
    scopePath: ['cart'],
    route: '/cart',
    description: 'Add item. Takes sku, quantity.',
    safety: 'mutate',
    lifetime: 'view',
    inputSchema: {
      type: 'object',
      properties: {
        sku: {type: 'string', description: ''},
        quantity: {type: 'number', description: ''},
      },
      required: ['sku'],
    },
    binding: {
      kind: 'handler',
      file: 'Cart.js',
      line: 3,
      column: 2,
      component: 'Cart',
      handler: 'addItem',
      params: ['sku', 'quantity'],
      paramStyle: 'positional',
    },
    evidence: [],
    status: 'proposed',
    inferredAt: '2026-11-01T00:00:00.000Z',
    provider: null,
    ...overrides,
  };
}

function context() {
  return {
    source: {dir: sourceDir, files: ['Cart.js']},
    now: '2026-11-01T00:00:00.000Z',
  };
}

function suggestionsText(suggestions) {
  return JSON.stringify({suggestions});
}

describe('infer synthesize providers', () => {
  beforeEach(() => {
    sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'react-webmcp-llm-'));
    fs.writeFileSync(
      path.join(sourceDir, 'Cart.js'),
      [
        'function Cart() {',
        '  const [cart, setCart] = useState({});',
        '  const addItem = (sku, quantity) => setCart(c => ({...c, [sku]: quantity}));',
        '  return null;',
        '}',
        '',
      ].join('\n'),
    );
  });

  afterEach(() => {
    fs.rmSync(sourceDir, {recursive: true, force: true});
  });

  describe('shared prompt and validation', () => {
    it('reads a numbered excerpt around the binding', () => {
      const excerpt = llm.readExcerpt(sourceDir, proposal(), 1);
      expect(excerpt.split('\n')).toEqual([
        ' 2|   const [cart, setCart] = useState({});',
        '>3|   const addItem = (sku, quantity) => setCart(c => ({...c, [sku]: quantity}));',
        ' 4|   return null;',
      ]);
      expect(
        llm.readExcerpt(
          sourceDir,
          proposal({binding: {...proposal().binding, file: 'Nope.js'}}),
          1,
        ),
      ).toBe(null);
    });

    it('builds a request with the candidate, its parameters and source', () => {
      const request = llm.buildRequest([proposal()], context(), 1);
      expect(request.system).toContain('snake_case');
      expect(request.prompt).toContain('id: Cart.js#Cart.addItem');
      expect(request.prompt).toContain(
        'parameters: sku: string, quantity: number?',
      );
      expect(request.prompt).toContain('>3|   const addItem');
      expect(request.schema).toBe(llm.SUGGESTIONS_SCHEMA);
    });

    it('batches proposals', () => {
      const items = [1, 2, 3, 4, 5].map(n => proposal({id: 'p' + n}));
      expect(llm.batchProposals(items, 2).map(batch => batch.length)).toEqual([
        2, 2, 1,
      ]);
    });

    it('rejects malformed suggestions and keeps the original', () => {
      const warnings = [];
      const batch = [proposal(), proposal({id: 'other'})];
      const applied = llm.applySuggestions(
        batch,
        llm.parseSuggestions(
          suggestionsText([
            {id: 'Cart.js#Cart.addItem', name: 'Add Item!', description: 'x'},
            {id: 'unknown', name: 'fine', description: 'Fine.'},
          ]),
        ),
        'test',
        message => warnings.push(message),
      );
      expect(applied[0].name).toBe('add_item');
      expect(applied[1].name).toBe('add_item');
      expect(warnings).toEqual([
        'test: Cart.js#Cart.addItem: name "Add Item!" is not snake_case; kept as is',
        'test: no suggestion for other; kept as is',
      ]);
      expect(
        llm.validateSuggestion({
          id: 'x',
          name: 'a'.repeat(31),
          description: 'ok',
        }),
      ).toContain('longer than 30');
      expect(
        llm.validateSuggestion({id: 'x', name: 'ok_name', description: ''}),
      ).toBe('description is empty');
      expect(
        llm.validateSuggestion({
          id: 'x',
          name: 'ok_name',
          description: 'Fine.',
        }),
      ).toBe(null);
      expect(() => llm.parseSuggestions('not json')).toThrow(
        'did not return JSON',
      );
      expect(() => llm.parseSuggestions('{"nope": []}')).toThrow(
        'no "suggestions" array',
      );
    });
  });

  describe('anthropic', () => {
    it('sends one structured request per batch through the SDK client', async () => {
      const calls = [];
      const client = {
        beta: {
          messages: {
            create: async params => {
              calls.push(params);
              const ids = JSON.parse(
                params.messages[0].content
                  .match(/id: (\S+)/g)
                  .map(m => m.slice(4)).length > 0
                  ? JSON.stringify(
                      params.messages[0].content
                        .match(/id: (\S+)/g)
                        .map(m => m.slice(4)),
                    )
                  : '[]',
              );
              return {
                stop_reason: 'end_turn',
                content: [
                  {
                    type: 'text',
                    text: suggestionsText(
                      ids.map(id => ({
                        id,
                        name: 'add_to_cart',
                        description:
                          'Add an inventory item to the cart by SKU.',
                      })),
                    ),
                  },
                ],
              };
            },
          },
        },
      };
      const provider = createAnthropicProvider({
        client,
        env: {},
        warn: () => {},
        batchSize: 1,
      });
      expect(provider.name).toBe('anthropic:claude-opus-5-5');
      const result = await provider.synthesize(
        [proposal(), proposal({id: 'p2'})],
        context(),
      );
      expect(result.map(p => [p.id, p.name])).toEqual([
        ['Cart.js#Cart.addItem', 'add_to_cart'],
        ['p2', 'add_to_cart'],
      ]);
      expect(calls).toHaveLength(2);
      const params = calls[0];
      expect(params.model).toBe('claude-opus-5-5');
      expect(params.max_tokens).toBe(16000);
      expect(params.output_config).toEqual({
        effort: 'medium',
        format: {type: 'json_schema', schema: llm.SUGGESTIONS_SCHEMA},
      });
      expect(params.betas).toEqual(['server-side-fallback-2026-07-01']);
      expect(params.fallbacks).toBe('default');
      expect(params.thinking).toBe(undefined);
      expect(params.messages[0].role).toBe('user');
      expect(params.system).toBe(llm.SYSTEM_PROMPT);
    });

    it('honors the model and fallback environment overrides', async () => {
      let seen = null;
      const client = {
        beta: {
          messages: {
            create: async params => {
              seen = params;
              return {
                stop_reason: 'end_turn',
                content: [{type: 'text', text: suggestionsText([])}],
              };
            },
          },
        },
      };
      const provider = createAnthropicProvider({
        client,
        env: {
          REACT_WEBMCP_ANTHROPIC_MODEL: 'claude-sonnet-5-5',
          REACT_WEBMCP_ANTHROPIC_FALLBACKS: 'off',
        },
        warn: () => {},
      });
      expect(provider.name).toBe('anthropic:claude-sonnet-5-5');
      await provider.synthesize([proposal()], context());
      expect(seen.model).toBe('claude-sonnet-5-5');
      expect(seen.betas).toBe(undefined);
      expect(seen.fallbacks).toBe(undefined);
    });

    it('surfaces refusals and truncation as errors', async () => {
      const refusing = createAnthropicProvider({
        client: {
          beta: {
            messages: {
              create: async () => ({
                stop_reason: 'refusal',
                stop_details: {
                  type: 'refusal',
                  category: null,
                  explanation: 'no',
                },
                content: [],
              }),
            },
          },
        },
        env: {},
        warn: () => {},
      });
      await expect(
        refusing.synthesize([proposal()], context()),
      ).rejects.toThrow('the model declined the request: no');
      const truncated = createAnthropicProvider({
        client: {
          beta: {
            messages: {
              create: async () => ({stop_reason: 'max_tokens', content: []}),
            },
          },
        },
        env: {},
        warn: () => {},
      });
      await expect(
        truncated.synthesize([proposal()], context()),
      ).rejects.toThrow('cut off');
    });
  });

  describe('gemini', () => {
    it('posts a generateContent request with a response schema', async () => {
      const calls = [];
      const fetchImpl = async (url, init) => {
        calls.push({url, init});
        return {
          ok: true,
          status: 200,
          json: async () => ({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: suggestionsText([
                        {
                          id: 'Cart.js#Cart.addItem',
                          name: 'add_cart_item',
                          description: 'Add an item to the cart.',
                        },
                      ]),
                    },
                  ],
                },
              },
            ],
          }),
        };
      };
      const provider = createGeminiProvider({
        fetch: fetchImpl,
        env: {GEMINI_API_KEY: 'test-key'},
        warn: () => {},
      });
      expect(provider.name).toBe('gemini:gemini-2.5-flash');
      const result = await provider.synthesize([proposal()], context());
      expect(result[0].name).toBe('add_cart_item');
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
      );
      expect(calls[0].init.headers['x-goog-api-key']).toBe('test-key');
      const body = JSON.parse(calls[0].init.body);
      expect(body.generationConfig.responseMimeType).toBe('application/json');
      expect(body.generationConfig.responseSchema.additionalProperties).toBe(
        undefined,
      );
      expect(
        body.generationConfig.responseSchema.properties.suggestions.items
          .additionalProperties,
      ).toBe(undefined);
      expect(body.systemInstruction.parts[0].text).toBe(llm.SYSTEM_PROMPT);
      expect(body.contents[0].parts[0].text).toContain(
        'id: Cart.js#Cart.addItem',
      );
    });

    it('fails clearly without a key or on an HTTP error', async () => {
      const noKey = createGeminiProvider({
        fetch: async () => ({}),
        env: {},
        warn: () => {},
      });
      await expect(noKey.synthesize([proposal()], context())).rejects.toThrow(
        'GEMINI_API_KEY',
      );
      const failing = createGeminiProvider({
        fetch: async () => ({
          ok: false,
          status: 403,
          text: async () => 'denied',
        }),
        env: {GEMINI_API_KEY: 'k'},
        warn: () => {},
      });
      await expect(failing.synthesize([proposal()], context())).rejects.toThrow(
        'Gemini returned HTTP 403: denied',
      );
    });

    it('strips additionalProperties recursively for Gemini schemas', () => {
      expect(
        toGeminiSchema({
          type: 'object',
          additionalProperties: false,
          properties: {
            list: {
              type: 'array',
              items: {type: 'object', additionalProperties: false},
            },
          },
        }),
      ).toEqual({
        type: 'object',
        properties: {list: {type: 'array', items: {type: 'object'}}},
      });
    });
  });

  it('runs a network provider through synthesizeProposals', async () => {
    const provider = createGeminiProvider({
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: suggestionsText([
                      {
                        id: 'Cart.js#Cart.addItem',
                        name: 'add_cart_item',
                        description: 'Add an item to the cart.',
                      },
                    ]),
                  },
                ],
              },
            },
          ],
        }),
      }),
      env: {GEMINI_API_KEY: 'k'},
      warn: () => {},
    });
    const file = {
      version: 1,
      generatedAt: '',
      source: {dir: sourceDir, files: ['Cart.js']},
      proposals: [proposal(), proposal({id: 'done', status: 'exported'})],
    };
    const result = await synthesizeProposals(file, provider);
    expect(result.touched.map(p => [p.qualifiedName, p.provider])).toEqual([
      ['cart_add_cart_item', 'gemini:gemini-2.5-flash'],
    ]);
    expect(result.file.proposals[1].name).toBe('add_item');
  });

  describe('openai-compatible', () => {
    function okResponse(content, extra) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{message: {content}, finish_reason: 'stop', ...extra}],
        }),
      };
    }

    it('posts a chat completion with a JSON schema and bearer auth', async () => {
      const seen = [];
      const provider = createOpenAIProvider({
        fetch: async (url, init) => {
          seen.push({url, init});
          return okResponse(
            suggestionsText([
              {
                id: 'Cart.js#Cart.addItem',
                name: 'add_cart_item',
                description: 'Add an item to the cart by SKU.',
              },
            ]),
          );
        },
        env: {OPENAI_API_KEY: 'k', REACT_WEBMCP_OPENAI_MODEL: 'some-model'},
        warn: () => {},
      });
      expect(provider.name).toBe('openai:some-model');
      const result = await provider.synthesize([proposal()], context());
      expect(result[0].name).toBe('add_cart_item');
      expect(seen).toHaveLength(1);
      expect(seen[0].url).toBe('https://api.openai.com/v1/chat/completions');
      expect(seen[0].init.headers.authorization).toBe('Bearer k');
      const body = JSON.parse(seen[0].init.body);
      expect(body.model).toBe('some-model');
      expect(body.messages.map(m => m.role)).toEqual(['system', 'user']);
      expect(body.messages[0].content).toBe(llm.SYSTEM_PROMPT);
      expect(body.response_format).toEqual({
        type: 'json_schema',
        json_schema: {
          name: 'suggestions',
          schema: llm.SUGGESTIONS_SCHEMA,
          strict: true,
        },
      });
    });

    it('talks to a local server without a key and tolerates fenced JSON', async () => {
      const seen = [];
      const provider = createOpenAIProvider({
        fetch: async (url, init) => {
          seen.push({url, init});
          return okResponse(
            '```json\n' +
              suggestionsText([
                {
                  id: 'Cart.js#Cart.addItem',
                  name: 'add_cart_item',
                  description: 'Add an item to the cart.',
                },
              ]) +
              '\n```',
          );
        },
        baseURL: 'http://localhost:11434/v1/',
        model: 'llama3.1',
        env: {REACT_WEBMCP_OPENAI_JSON: 'object'},
        warn: () => {},
      });
      expect(provider.name).toBe('openai@localhost:11434:llama3.1');
      const result = await provider.synthesize([proposal()], context());
      expect(result[0].name).toBe('add_cart_item');
      expect(seen[0].url).toBe('http://localhost:11434/v1/chat/completions');
      expect(seen[0].init.headers.authorization).toBe(undefined);
      expect(JSON.parse(seen[0].init.body).response_format).toEqual({
        type: 'json_object',
      });
    });

    it('fails clearly without a model, on HTTP errors, refusals and cut-offs', async () => {
      await expect(
        createOpenAIProvider({
          fetch: async () => okResponse('{}'),
          env: {},
        }).synthesize([proposal()], context()),
      ).rejects.toThrow('needs a model');
      await expect(
        createOpenAIProvider({
          fetch: async () => ({
            ok: false,
            status: 400,
            text: async () => 'unsupported response_format',
          }),
          model: 'm',
          env: {},
        }).synthesize([proposal()], context()),
      ).rejects.toThrow(
        'api.openai.com returned HTTP 400: unsupported response_format (this server may not support json_schema responses; set REACT_WEBMCP_OPENAI_JSON=object or none)',
      );
      await expect(
        createOpenAIProvider({
          fetch: async () => ({
            ok: true,
            status: 200,
            json: async () => ({
              choices: [{message: {refusal: 'no'}, finish_reason: 'stop'}],
            }),
          }),
          model: 'm',
          env: {},
        }).synthesize([proposal()], context()),
      ).rejects.toThrow('the model declined the request: no');
      await expect(
        createOpenAIProvider({
          fetch: async () => ({
            ok: true,
            status: 200,
            json: async () => ({
              choices: [{message: {content: '{'}, finish_reason: 'length'}],
            }),
          }),
          model: 'm',
          env: {},
        }).synthesize([proposal()], context()),
      ).rejects.toThrow('cut off');
      expect(() =>
        createOpenAIProvider({env: {REACT_WEBMCP_OPENAI_JSON: 'yaml'}}),
      ).toThrow('REACT_WEBMCP_OPENAI_JSON must be one of schema, object, none');
      expect(stripFence('  ```\n{"a":1}\n```  ')).toBe('{"a":1}');
      expect(stripFence('{"a":1}')).toBe('{"a":1}');
    });
  });

  describe('provider modules', () => {
    let dir;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'react-webmcp-provider-'));
    });
    afterEach(() => {
      fs.rmSync(dir, {recursive: true, force: true});
    });

    it('wraps a {name, complete} module in the shared prompt and validation', async () => {
      fs.writeFileSync(
        path.join(dir, 'completer.js'),
        `
        const seen = [];
        module.exports = {
          name: 'my-llm',
          seen,
          complete(request) {
            seen.push(request);
            return JSON.stringify({
              suggestions: [
                {id: 'Cart.js#Cart.addItem', name: 'add_cart_item', description: 'Add an item.'},
                {id: 'Cart.js#Cart.other', name: 'Not Snake', description: 'bad'},
              ],
            });
          },
        };
        `,
      );
      const warnings = [];
      const provider = getProvider('./completer.js', {
        cwd: dir,
        warn: message => warnings.push(message),
      });
      expect(provider.name).toBe('my-llm');
      const file = {
        version: 1,
        generatedAt: '',
        source: {dir: sourceDir, files: ['Cart.js']},
        proposals: [proposal(), proposal({id: 'Cart.js#Cart.other'})],
      };
      const result = await synthesizeProposals(file, provider);
      expect(result.touched.map(p => [p.qualifiedName, p.provider])).toEqual([
        ['cart_add_cart_item', 'my-llm'],
        ['cart_add_item', 'my-llm'],
      ]);
      expect(warnings).toEqual([
        'my-llm: Cart.js#Cart.other: name "Not Snake" is not snake_case; kept as is',
      ]);
      const module = require(path.join(dir, 'completer.js'));
      expect(module.seen).toHaveLength(1);
      expect(module.seen[0].system).toBe(llm.SYSTEM_PROMPT);
      expect(module.seen[0].prompt).toContain('id: Cart.js#Cart.addItem');
    });

    it('calls a factory with the model and uses a full provider as is', async () => {
      fs.writeFileSync(
        path.join(dir, 'factory.cjs'),
        `
        module.exports = function create(options) {
          return {
            name: 'factory:' + options.model + '@' + options.baseURL,
            async synthesize(proposals) {
              return proposals.map(p => ({...p, name: 'renamed', description: 'From the factory.'}));
            },
          };
        };
        `,
      );
      const provider = getProvider(path.join(dir, 'factory.cjs'), {
        model: 'm',
        baseURL: 'http://x',
      });
      expect(provider.name).toBe('factory:m@http://x');
      const result = await provider.synthesize([proposal()], context());
      expect(result[0].name).toBe('renamed');
    });

    it('explains unusable modules', () => {
      fs.writeFileSync(path.join(dir, 'empty.js'), 'module.exports = {};');
      expect(() => getProvider('./empty.js', {cwd: dir})).toThrow(
        'provider module ./empty.js must export {name, complete(request)}, {name, synthesize(proposals, context)}, or a function returning one of those',
      );
      expect(() => getProvider('./missing.js', {cwd: dir})).toThrow(
        'could not load provider module ./missing.js',
      );
    });
  });

  it('knows the providers by name and passes --model through', () => {
    expect(getProvider('fixture').name).toBe('fixture');
    expect(getProvider('anthropic', {model: 'x'}).name).toBe('anthropic:x');
    expect(getProvider('gemini', {model: 'y'}).name).toBe('gemini:y');
    expect(getProvider('openai', {model: 'z'}).name).toBe('openai:z');
    expect(() => getProvider('nope')).toThrow(
      'unknown provider "nope"; expected one of fixture, anthropic, gemini, openai, or the path of a provider module such as ./my-provider.js',
    );
  });
});
