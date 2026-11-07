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

const {
  DEFAULT_FIXTURE_DIR,
  checkBudgets,
  checkDrift,
  checkRegistrationCrossCheck,
  checkRegistry,
  checkStatic,
  parseArgs,
  projectForManifest,
  report,
  resolveSourceFile,
  simpleDiff,
} = require('react-webmcp/validate/run.flow');

// The checks take what `collect` reads from the page through
// react_get_agent_tools; these build that shape without a browser.
function tool(overrides = {}) {
  const name = overrides.name || 'add_item';
  const scopePath = overrides.scopePath || ['cart'];
  const qualifiedName =
    overrides.qualifiedName || scopePath.concat(name).join('_');
  return {
    key: qualifiedName,
    qualifiedName,
    name,
    scopePath,
    description: 'Add an item to the cart.',
    inputSchema: {
      type: 'object',
      properties: {sku: {type: 'string', description: 'SKU of the item.'}},
      required: ['sku'],
    },
    annotations: {},
    safety: 'mutate',
    lifetime: 'view',
    source: 'tree',
    status: 'registered',
    availability: {
      enabled: true,
      scopeAvailable: true,
      hidden: false,
      supported: true,
    },
    error: null,
    owner: {uid: 'r1', name: 'Cart', type: 'function'},
    ownerSource: {
      name: 'Cart',
      fileName: 'webpack-internal:///./src/App.js',
      line: 10,
      column: 1,
    },
    ...overrides,
  };
}

// By default the browser holds exactly the tools the registry says are
// registered, which is what the cross-check expects.
function collected(tools, registeredNames) {
  return {
    registryFound: true,
    tools,
    registeredNames:
      registeredNames === undefined
        ? tools
            .filter(item => item.status === 'registered')
            .map(item => item.qualifiedName)
        : registeredNames,
  };
}

function options(overrides = {}) {
  return {
    update: false,
    fixtureDir: DEFAULT_FIXTURE_DIR,
    manifestPath: path.join(DEFAULT_FIXTURE_DIR, 'tools.manifest.json'),
    url: null,
    skipStatic: false,
    skipSuspense: false,
    help: false,
    ...overrides,
  };
}

function levels(findings) {
  return findings.map(finding => [finding.level, finding.check, finding.tool]);
}

let tmp;

describe('react-webmcp contract check', () => {
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'react-webmcp-validate-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, {recursive: true, force: true});
  });

  describe('parseArgs', () => {
    it('defaults to the committed fixture and its manifest', () => {
      expect(parseArgs([])).toEqual({
        update: false,
        fixtureDir: DEFAULT_FIXTURE_DIR,
        manifestPath: path.join(DEFAULT_FIXTURE_DIR, 'tools.manifest.json'),
        url: null,
        skipStatic: false,
        skipSuspense: false,
        help: false,
      });
      expect(path.isAbsolute(DEFAULT_FIXTURE_DIR)).toBe(true);
      expect(
        DEFAULT_FIXTURE_DIR.endsWith(path.join('fixtures', 'webmcp')),
      ).toBe(true);
    });

    it('reads every flag', () => {
      expect(
        parseArgs([
          '--update',
          '--fixture',
          'my-fixture',
          '--url',
          'http://127.0.0.1:3000/',
          '--skip-static',
          '--skip-suspense',
        ]),
      ).toEqual({
        update: true,
        fixtureDir: path.resolve('my-fixture'),
        // The manifest follows the fixture unless given explicitly.
        manifestPath: path.resolve('my-fixture', 'tools.manifest.json'),
        url: 'http://127.0.0.1:3000/',
        skipStatic: true,
        skipSuspense: true,
        help: false,
      });
      expect(
        parseArgs(['--fixture', 'my-fixture', '--manifest', 'elsewhere.json'])
          .manifestPath,
      ).toBe(path.resolve('elsewhere.json'));
      expect(parseArgs(['--help']).help).toBe(true);
      expect(parseArgs(['-h']).help).toBe(true);
    });

    it('rejects an unknown argument', () => {
      expect(() => parseArgs(['--nope'])).toThrow('Unknown argument: --nope');
      expect(() => parseArgs(['--update', 'extra'])).toThrow(
        'Unknown argument: extra',
      );
    });
  });

  describe('projectForManifest', () => {
    it('keeps the agent-facing fields, sorted by qualified name', () => {
      const projection = projectForManifest([
        tool({name: 'list_items', safety: 'read', inputSchema: undefined}),
        tool({owner: null}),
      ]);
      expect(projection).toEqual([
        {
          qualifiedName: 'cart_add_item',
          name: 'add_item',
          scopePath: ['cart'],
          description: 'Add an item to the cart.',
          inputSchema: {
            type: 'object',
            properties: {
              sku: {type: 'string', description: 'SKU of the item.'},
            },
            required: ['sku'],
          },
          annotations: {},
          safety: 'mutate',
          lifetime: 'view',
          source: 'tree',
          owner: null,
        },
        {
          qualifiedName: 'cart_list_items',
          name: 'list_items',
          scopePath: ['cart'],
          description: 'Add an item to the cart.',
          // Absent schemas serialize as null so the manifest is stable JSON.
          inputSchema: null,
          annotations: {},
          safety: 'read',
          lifetime: 'view',
          source: 'tree',
          // Only the name: uids change between page loads.
          owner: {name: 'Cart'},
        },
      ]);
      // Nothing that changes between runs (status, availability, key,
      // ownerSource) is part of the manifest.
      expect(Object.keys(projection[0]).sort()).toEqual([
        'annotations',
        'description',
        'inputSchema',
        'lifetime',
        'name',
        'owner',
        'qualifiedName',
        'safety',
        'scopePath',
        'source',
      ]);
    });
  });

  describe('checkRegistry', () => {
    it('needs the registry and at least one tool', () => {
      expect(
        levels(
          checkRegistry({registryFound: false, tools: [], registeredNames: []}),
        ),
      ).toEqual([['error', 'registry', null]]);
      expect(
        checkRegistry({registryFound: false, tools: [], registeredNames: []})[0]
          .message,
      ).toContain('does not expose the react-webmcp registry');
      expect(levels(checkRegistry(collected([])))).toEqual([
        ['error', 'registry', null],
      ]);
      expect(checkRegistry(collected([]))[0].message).toBe(
        'The registry contains no tools.',
      );
      expect(checkRegistry(collected([tool()]))).toEqual([]);
    });
  });

  describe('checkRegistrationCrossCheck', () => {
    it('passes when the browser holds exactly the registered tools', () => {
      const tools = [
        tool(),
        tool({name: 'list_items'}),
        tool({name: 'hidden_one', status: 'unavailable'}),
        tool({name: 'off', status: 'disabled'}),
      ];
      expect(checkRegistrationCrossCheck(collected(tools))).toEqual([]);
      // Order does not matter.
      expect(
        checkRegistrationCrossCheck(
          collected(tools, ['cart_list_items', 'cart_add_item']),
        ),
      ).toEqual([]);
    });

    it('names what is missing from the browser and what React does not own', () => {
      const tools = [tool(), tool({name: 'list_items'})];
      const findings = checkRegistrationCrossCheck(
        collected(tools, ['cart_add_item', 'legacy_tool']),
      );
      expect(levels(findings)).toEqual([['error', 'registration', null]]);
      expect(findings[0].message).toBe(
        'Registered tools differ from the registry. Missing from the ' +
          'browser: [cart_list_items]. In the browser but not registered by ' +
          'React: [legacy_tool].',
      );
      // A tool the registry marks unavailable must not be in the browser.
      expect(
        checkRegistrationCrossCheck(
          collected([tool({status: 'unavailable'})], ['cart_add_item']),
        )[0].message,
      ).toContain(
        'In the browser but not registered by React: [cart_add_item]',
      );
    });
  });

  describe('checkBudgets', () => {
    it('passes a well-formed tool', () => {
      expect(checkBudgets(collected([tool()]))).toEqual([]);
      expect(
        checkBudgets(collected([tool({name: 'list_items', safety: 'read'})])),
      ).toEqual([]);
    });

    it('warns about oversized names and descriptions', () => {
      const long = tool({
        qualifiedName: 'a_qualified_name_that_is_longer_than_thirty',
        description: 'x'.repeat(501),
        inputSchema: {
          type: 'object',
          properties: {sku: {type: 'string', description: 'y'.repeat(151)}},
        },
      });
      const findings = checkBudgets(collected([long]));
      expect(levels(findings)).toEqual([
        ['warn', 'budget', long.qualifiedName],
        ['warn', 'budget', long.qualifiedName],
        ['warn', 'budget', long.qualifiedName],
      ]);
      expect(findings.map(finding => finding.message)).toEqual([
        'The name is 43 characters; agents may truncate names over 30.',
        'The description is 501 characters; keep it under 500.',
        'The description of parameter "sku" is over 150 characters.',
      ]);
      // The limits themselves are fine.
      expect(
        checkBudgets(
          collected([
            tool({
              qualifiedName: 'x'.repeat(30),
              description: 'x'.repeat(500),
              inputSchema: {
                type: 'object',
                properties: {sku: {description: 'y'.repeat(150)}},
              },
            }),
          ]),
        ),
      ).toEqual([]);
    });

    it('warns about missing or misleading safety', () => {
      const findings = checkBudgets(
        collected([
          tool({safety: null}),
          tool({name: 'delete_item', safety: 'read'}),
          tool({name: 'read_items', safety: 'read'}),
        ]),
      );
      expect(levels(findings)).toEqual([
        ['warn', 'safety', 'cart_add_item'],
        ['warn', 'safety', 'cart_delete_item'],
      ]);
      expect(findings[0].message).toContain('No safety classification.');
      expect(findings[1].message).toBe(
        'Marked "read" but named like a mutation ("delete_item").',
      );
    });

    it('reports tools that share an agent-facing name', () => {
      const findings = checkBudgets(
        collected([tool(), tool({key: 'other'}), tool({name: 'clear'})]),
      );
      expect(levels(findings)).toEqual([['error', 'budget', 'cart_add_item']]);
      expect(findings[0].message).toBe('2 tools share this agent-facing name.');
    });
  });

  describe('checkDrift', () => {
    function manifestFor(tools) {
      return (
        JSON.stringify(
          {
            version: 1,
            note:
              'Generated by `yarn validate-tools --update`. Review changes to ' +
              'this file like any other change to the agent-facing surface.',
            tools: projectForManifest(tools),
          },
          null,
          2,
        ) + '\n'
      );
    }

    it('creates a missing manifest and says so', () => {
      const manifestPath = path.join(tmp, 'nested', 'tools.manifest.json');
      const findings = checkDrift(collected([tool()]), options({manifestPath}));
      expect(levels(findings)).toEqual([['warn', 'drift', null]]);
      expect(findings[0].message).toContain('Created ');
      expect(findings[0].message).toContain('with 1 tools.');
      expect(fs.readFileSync(manifestPath, 'utf8')).toBe(manifestFor([tool()]));
    });

    it('passes when the surface matches the manifest byte for byte', () => {
      const manifestPath = path.join(tmp, 'tools.manifest.json');
      const tools = [tool({name: 'list_items', safety: 'read'}), tool()];
      fs.writeFileSync(manifestPath, manifestFor(tools));
      expect(checkDrift(collected(tools), options({manifestPath}))).toEqual([]);
      // Fields outside the projection (status, uids) do not count as drift.
      expect(
        checkDrift(
          collected(
            tools.map(item => ({
              ...item,
              status: 'unavailable',
              owner: {...item.owner, uid: 'r99'},
            })),
          ),
          options({manifestPath}),
        ),
      ).toEqual([]);
    });

    it('fails with a diff when the surface changed, and --update accepts it', () => {
      const manifestPath = path.join(tmp, 'tools.manifest.json');
      fs.writeFileSync(manifestPath, manifestFor([tool()]));
      const changed = collected([
        tool({description: 'Add an item to the cart by SKU.'}),
      ]);
      const findings = checkDrift(changed, options({manifestPath}));
      expect(levels(findings)).toEqual([['error', 'drift', null]]);
      expect(findings[0].message).toContain('The tool surface differs from ');
      expect(findings[0].message).toContain(
        'run `yarn validate-tools --update` to accept it.',
      );
      expect(findings[0].message).toContain(
        '-       "description": "Add an item to the cart.",',
      );
      expect(findings[0].message).toContain(
        '+       "description": "Add an item to the cart by SKU.",',
      );
      // Nothing was written.
      expect(fs.readFileSync(manifestPath, 'utf8')).toBe(manifestFor([tool()]));

      const updated = checkDrift(
        changed,
        options({manifestPath, update: true}),
      );
      expect(levels(updated)).toEqual([['info', 'drift', null]]);
      expect(updated[0].message).toContain('Updated ');
      expect(fs.readFileSync(manifestPath, 'utf8')).toBe(
        manifestFor(changed.tools),
      );
      expect(checkDrift(changed, options({manifestPath}))).toEqual([]);
    });
  });

  describe('simpleDiff', () => {
    it('lists changed lines with - and + prefixes', () => {
      expect(simpleDiff('a\nb\nc', 'a\nB\nc')).toBe('- b\n+ B');
      expect(simpleDiff('a', 'a\nb')).toBe('+ b');
      expect(simpleDiff('a\nb', 'a')).toBe('- b');
      expect(simpleDiff('same', 'same')).toBe('');
    });

    it('stops after 60 lines', () => {
      const expected = Array.from({length: 100}, (_, i) => `e${i}`).join('\n');
      const actual = Array.from({length: 100}, (_, i) => `a${i}`).join('\n');
      const lines = simpleDiff(expected, actual).split('\n');
      expect(lines).toHaveLength(60);
      expect(lines[0]).toBe('- e0');
      expect(lines[1]).toBe('+ a0');
      expect(lines[59]).toBe('+ a29');
    });
  });

  describe('resolveSourceFile', () => {
    it('maps the file names a page reports onto the fixture', () => {
      const file = path.join(tmp, 'src', 'App.js');
      fs.mkdirSync(path.dirname(file), {recursive: true});
      fs.writeFileSync(file, '');
      expect(resolveSourceFile('webpack-internal:///./src/App.js', tmp)).toBe(
        file,
      );
      expect(resolveSourceFile('webpack://app/./src/App.js?abc123', tmp)).toBe(
        file,
      );
      expect(resolveSourceFile(file, tmp)).toBe(file);
    });

    it('returns null for files it cannot find or does not understand', () => {
      expect(
        resolveSourceFile('webpack-internal:///./src/Missing.js', tmp),
      ).toBe(null);
      expect(resolveSourceFile('webpack://app/src/App.js', tmp)).toBe(null);
      expect(resolveSourceFile(path.join(tmp, 'missing.js'), tmp)).toBe(null);
      expect(
        resolveSourceFile('http://localhost/static/js/bundle.js', tmp),
      ).toBe(null);
      expect(resolveSourceFile('src/App.js', tmp)).toBe(null);
    });
  });

  describe('checkStatic', () => {
    function writeOwnerFile(source) {
      const file = path.join(tmp, 'src', 'App.js');
      fs.mkdirSync(path.dirname(file), {recursive: true});
      fs.writeFileSync(file, source);
      return file;
    }

    it('passes when the schema and the handler agree', () => {
      writeOwnerFile(`
        function Cart() {
          useWebMCPTool({
            name: 'add_item',
            description: 'Add an item to the cart.',
            inputSchema: {type: 'object', properties: {sku: {type: 'string'}}, required: ['sku']},
            execute: ({sku}) => sku,
          });
          return null;
        }
      `);
      expect(checkStatic(collected([tool()]), tmp)).toEqual([]);
    });

    it('reports parameters the handler reads but the schema does not declare', () => {
      writeOwnerFile(`
        function Cart() {
          useWebMCPTool({
            name: 'add_item',
            description: 'Add an item to the cart.',
            inputSchema: {type: 'object', properties: {sku: {type: 'string'}}, required: ['sku']},
            execute: ({quantity}) => quantity,
          });
          return null;
        }
      `);
      const findings = checkStatic(collected([tool()]), tmp);
      expect(levels(findings)).toEqual([['error', 'static', 'cart_add_item']]);
      expect(findings[0].message).toContain(':3: ');
      expect(findings[0].message).toContain(
        'execute reads [quantity] but inputSchema does not declare them; ' +
          'inputSchema requires [sku] but execute never reads them; ' +
          'declared but unused: [sku].',
      );
    });

    it('notes what it had to skip', () => {
      writeOwnerFile(`
        const schema = require('./schema');
        function Cart() {
          useWebMCPTool({name: 'add_item', description: 'Add.', inputSchema: schema, execute: ({sku}) => sku});
          return null;
        }
      `);
      const findings = checkStatic(
        collected([
          tool(),
          tool({name: 'list_items'}),
          tool({
            name: 'elsewhere',
            ownerSource: {
              name: 'Cart',
              fileName: 'http://localhost/static/js/bundle.js',
              line: 1,
              column: 1,
            },
          }),
          // No owner: left to the binding check.
          tool({name: 'orphan', owner: null, ownerSource: null}),
        ]),
        tmp,
      );
      expect(levels(findings)).toEqual([
        ['info', 'static', 'cart_add_item'],
        ['warn', 'static', 'cart_list_items'],
        ['info', 'static', 'cart_elsewhere'],
      ]);
      expect(findings[0].message).toContain(
        'skipped (inputSchema is not a literal object; cannot compare statically.)',
      );
      expect(findings[1].message).toContain(
        'No useWebMCPTool call or <Tool> element named "list_items" was found',
      );
      expect(findings[2].message).toBe(
        'Skipped: the source file name "http://localhost/static/js/bundle.js" ' +
          'could not be mapped to a file in the fixture.',
      );
    });
  });

  describe('report', () => {
    let lines;

    beforeEach(() => {
      lines = [];
      jest.spyOn(process.stdout, 'write').mockImplementation(chunk => {
        lines.push(String(chunk));
        return true;
      });
    });

    afterEach(() => {
      process.stdout.write.mockRestore();
    });

    it('passes without errors, listing warnings and notes', () => {
      expect(
        report([
          {
            level: 'warn',
            check: 'budget',
            tool: 'cart_add_item',
            message: 'Long.',
          },
          {level: 'info', check: 'drift', tool: null, message: 'Created it.'},
        ]),
      ).toBe(0);
      const output = lines.join('');
      expect(output).toContain('1 warning(s)\n  [budget] cart_add_item: Long.');
      expect(output).toContain('1 note(s)\n  [drift]: Created it.');
      expect(output).toContain('react-webmcp contract check passed.');
      expect(output).not.toContain('error(s)');
    });

    it('fails on any error', () => {
      expect(
        report([
          {
            level: 'error',
            check: 'binding',
            tool: 'cart_add_item',
            message: 'No owner.',
          },
          {
            level: 'warn',
            check: 'safety',
            tool: 'cart_add_item',
            message: 'None.',
          },
        ]),
      ).toBe(1);
      const output = lines.join('');
      expect(output).toContain(
        '1 error(s)\n  [binding] cart_add_item: No owner.',
      );
      expect(output).toContain('react-webmcp contract check failed.');
    });
  });
});
