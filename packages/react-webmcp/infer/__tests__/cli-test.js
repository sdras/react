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

const {main, parseFlags} = require('react-webmcp/infer/cli.flow');
const {MARKER} = require('react-webmcp/infer/emit.flow');

const INVENTORY = `
import * as React from 'react';
const {useState} = React;

function Inventory() {
  const [items, setItems] = useState([]);
  const addItem = (sku, quantity) =>
    setItems(current => current.concat({sku, quantity}));
  const clearCart = () => setItems([]);
  return (
    <div>
      <button type="button" onClick={() => addItem('TEA-001', 1)}>
        Add
      </button>
      <button type="button" onClick={clearCart}>
        Clear
      </button>
    </div>
  );
}
`;

let tmp;
let stdout;
let stderr;
let savedProvider;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
  return file;
}

function writeSource(relative, source) {
  const file = path.join(tmp, relative);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, source);
  return file;
}

async function run(args) {
  const code = await main(args);
  return {code, out: stdout.join(''), err: stderr.join('')};
}

// Runs extract on the sample source and returns the proposals file path,
// the source directory and the owner file, for the commands that take a
// proposals file as input.
async function extractSample() {
  const src = path.join(tmp, 'src');
  const app = writeSource('src/App.js', INVENTORY);
  const proposals = path.join(tmp, 'tools.proposals.json');
  const result = await run(['extract', '--src', src, '--out', proposals]);
  expect(result.code).toBe(0);
  return {src, app, proposals};
}

// Marks every proposal accepted, the way the review overlay's export does.
function acceptAll(proposalsFile, out) {
  const file = readJson(proposalsFile);
  return writeJson(out, {
    ...file,
    proposals: file.proposals.map(proposal => ({
      ...proposal,
      status: 'accepted',
    })),
  });
}

describe('infer-tools CLI', () => {
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'react-webmcp-cli-'));
    stdout = [];
    stderr = [];
    jest.spyOn(process.stdout, 'write').mockImplementation(chunk => {
      stdout.push(String(chunk));
      return true;
    });
    jest.spyOn(process.stderr, 'write').mockImplementation(chunk => {
      stderr.push(String(chunk));
      return true;
    });
    // The fixture provider is the default only while the environment does
    // not pick another one.
    savedProvider = process.env.REACT_WEBMCP_LLM;
    delete process.env.REACT_WEBMCP_LLM;
  });

  afterEach(() => {
    process.stdout.write.mockRestore();
    process.stderr.write.mockRestore();
    if (savedProvider === undefined) {
      delete process.env.REACT_WEBMCP_LLM;
    } else {
      process.env.REACT_WEBMCP_LLM = savedProvider;
    }
    fs.rmSync(tmp, {recursive: true, force: true});
  });

  describe('parseFlags', () => {
    const spec = {src: 'string', out: 'string', write: 'boolean'};

    it('reads --key=value and --key value', () => {
      expect(parseFlags(['--src=app/src', '--out', 'out.json'], spec)).toEqual({
        src: 'app/src',
        out: 'out.json',
      });
      // The last occurrence wins.
      expect(parseFlags(['--src', 'a', '--src', 'b'], spec)).toEqual({
        src: 'b',
      });
      // An equals sign inside the value belongs to the value.
      expect(parseFlags(['--out=a=b'], spec)).toEqual({out: 'a=b'});
    });

    it('reads boolean flags, with or without a value', () => {
      expect(parseFlags(['--write'], spec)).toEqual({write: true});
      expect(parseFlags(['--write=false', '--src', 'x'], spec)).toEqual({
        write: true,
        src: 'x',
      });
      expect(parseFlags([], spec)).toEqual({});
    });

    it('rejects a string flag without a value', () => {
      let error = null;
      try {
        parseFlags(['--out', 'x', '--src'], spec);
      } catch (thrown) {
        error = thrown;
      }
      expect(error).not.toBe(null);
      expect(error.message).toBe('--src needs a value');
      expect(error.usage).toBe(true);
    });

    it('rejects unknown flags and stray arguments', () => {
      expect(() => parseFlags(['--nope', 'x'], spec)).toThrow(
        'Unknown flag --nope',
      );
      expect(() => parseFlags(['--nope=x'], spec)).toThrow(
        'Unknown flag --nope',
      );
      expect(() => parseFlags(['extra'], spec)).toThrow(
        'Unexpected argument: extra',
      );
      expect(() => parseFlags(['-s', 'x'], spec)).toThrow(
        'Unexpected argument: -s',
      );
    });
  });

  describe('main', () => {
    it('prints usage for help and for no command', async () => {
      const forms = [[], ['help'], ['--help'], ['-h']];
      for (let i = 0; i < forms.length; i++) {
        stdout = [];
        const result = await run(forms[i]);
        expect(result.code).toBe(0);
        expect(result.out).toContain('Usage: yarn infer-tools <command>');
        expect(result.err).toBe('');
      }
    });

    it('fails an unknown command with a usage hint', async () => {
      const result = await run(['frobnicate']);
      expect(result.code).toBe(1);
      expect(result.err).toContain('infer-tools: Unknown command: frobnicate');
      expect(result.err).toContain('Run `yarn infer-tools help` for usage.');
      expect(result.out).toBe('');
    });

    it('extract writes a proposals file next to the source directory by default', async () => {
      const src = path.join(tmp, 'src');
      writeSource('src/App.js', INVENTORY);
      const result = await run(['extract', '--src', src]);
      expect(result.code).toBe(0);
      const file = readJson(path.join(tmp, 'tools.proposals.json'));
      expect(file.version).toBe(1);
      expect(typeof file.generatedAt).toBe('string');
      expect(file.source.files).toEqual(['App.js']);
      expect(path.resolve(file.source.dir)).toBe(src);
      expect(
        file.proposals.map(proposal => [
          proposal.id,
          proposal.qualifiedName,
          proposal.route,
          proposal.status,
        ]),
      ).toEqual([
        ['App.js#Inventory.addItem', 'add_item', '/inventory', 'proposed'],
        ['App.js#Inventory.clearCart', 'clear_cart', '/inventory', 'proposed'],
      ]);
      expect(result.out).toContain('Analyzed 1 file(s)');
      expect(result.out).toContain('Wrote 2 proposal(s) (2 proposed) to');
      expect(result.out).toContain('nothing is published automatically');
    });

    it('extract honors --out and --route-from', async () => {
      writeSource('src/pages/cart/index.js', INVENTORY);
      const out = path.join(tmp, 'elsewhere', 'proposals.json');
      const result = await run([
        'extract',
        '--src',
        path.join(tmp, 'src'),
        '--out',
        out,
        '--route-from',
        'component',
      ]);
      expect(result.code).toBe(0);
      expect(fs.existsSync(path.join(tmp, 'tools.proposals.json'))).toBe(false);
      const file = readJson(out);
      expect(file.source.files).toEqual(['pages/cart/index.js']);
      expect(file.proposals.map(proposal => proposal.route)).toEqual([
        '/inventory',
        '/inventory',
      ]);
      // The same tree grouped by path.
      const byPath = path.join(tmp, 'by-path.json');
      expect(
        (
          await run([
            'extract',
            '--src',
            path.join(tmp, 'src'),
            '--out',
            byPath,
          ])
        ).code,
      ).toBe(0);
      expect(
        readJson(byPath).proposals.map(proposal => proposal.route),
      ).toEqual(['/cart', '/cart']);
    });

    it('extract rejects a missing --src and an unknown --route-from', async () => {
      let result = await run(['extract']);
      expect(result.code).toBe(1);
      expect(result.err).toContain('infer-tools: extract needs --src');

      writeSource('src/App.js', INVENTORY);
      result = await run([
        'extract',
        '--src',
        path.join(tmp, 'src'),
        '--route-from',
        'bogus',
      ]);
      expect(result.code).toBe(1);
      expect(result.err).toContain(
        '--route-from must be one of path, scope, component',
      );
      expect(fs.existsSync(path.join(tmp, 'tools.proposals.json'))).toBe(false);
    });

    it('synthesize rejects anything but a version 1 proposals file', async () => {
      const missing = path.join(tmp, 'missing.json');
      let result = await run(['synthesize', '--in', missing]);
      expect(result.code).toBe(1);
      expect(result.err).toContain(`${missing} does not exist`);

      const broken = writeSource('broken.json', '{not json');
      result = await run(['synthesize', '--in', broken]);
      expect(result.code).toBe(1);
      expect(result.err).toContain(`${broken} is not valid JSON`);

      const wrongVersion = writeJson(path.join(tmp, 'v2.json'), {
        version: 2,
        proposals: [],
      });
      result = await run(['synthesize', '--in', wrongVersion]);
      expect(result.code).toBe(1);
      expect(result.err).toContain(
        `${wrongVersion} is not a version 1 proposals file`,
      );

      const noProposals = writeJson(path.join(tmp, 'none.json'), {version: 1});
      result = await run(['synthesize', '--in', noProposals]);
      expect(result.code).toBe(1);
      expect(result.err).toContain('is not a version 1 proposals file');
    });

    it('synthesize describes proposed entries with the fixture provider by default', async () => {
      const {proposals} = await extractSample();
      const before = readJson(proposals);
      const out = path.join(tmp, 'described.json');
      const result = await run(['synthesize', '--in', proposals, '--out', out]);
      expect(result.code).toBe(0);
      expect(result.out).toContain('fixture: described 2 proposal(s)');
      const after = readJson(out);
      expect(after.proposals.map(proposal => proposal.provider)).toEqual([
        'fixture',
        'fixture',
      ]);
      expect(after.proposals.map(proposal => proposal.description)).toEqual([
        'Add an item (sku, quantity) in Inventory.',
        'Clear the cart in Inventory. This cannot be undone.',
      ]);
      // --out leaves the input alone; without it the file is rewritten in
      // place.
      expect(readJson(proposals)).toEqual(before);
      expect((await run(['synthesize', '--in', proposals])).code).toBe(0);
      expect(readJson(proposals).proposals.map(p => p.provider)).toEqual([
        'fixture',
        'fixture',
      ]);
      // Entries that are not `proposed` are left alone.
      const accepted = acceptAll(proposals, path.join(tmp, 'accepted.json'));
      stdout = [];
      expect((await run(['synthesize', '--in', accepted])).code).toBe(0);
      expect(stdout.join('')).toContain('fixture: described 0 proposal(s)');
    });

    it('emit prints a diff and writes nothing by default', async () => {
      const {app, proposals} = await extractSample();
      const accepted = acceptAll(proposals, path.join(tmp, 'accepted.json'));
      const result = await run(['emit', '--accepted', accepted]);
      expect(result.code).toBe(0);
      expect(fs.readFileSync(app, 'utf8')).toBe(INVENTORY);
      expect(result.out).toContain('plan  add_item -> App.js (Inventory)');
      expect(result.out).toContain('plan  clear_cart -> App.js (Inventory)');
      expect(result.out).toContain('--- a/App.js');
      expect(result.out).toContain('+++ b/App.js');
      expect(result.out).toContain(`+  // ${MARKER}`);
      expect(result.out).toContain(
        'Dry run: 2 tool skeleton(s) would be inserted into 1 file(s); ' +
          'skipped 0. Pass --write to apply.',
      );
      // --dry-run is the same as the default.
      stdout = [];
      expect(
        (await run(['emit', '--accepted', accepted, '--dry-run'])).code,
      ).toBe(0);
      expect(fs.readFileSync(app, 'utf8')).toBe(INVENTORY);
    });

    it('emit --write inserts marked skeletons for the accepted proposals', async () => {
      const {app, proposals} = await extractSample();
      const accepted = acceptAll(proposals, path.join(tmp, 'accepted.json'));
      const result = await run(['emit', '--accepted', accepted, '--write']);
      expect(result.code).toBe(0);
      const source = fs.readFileSync(app, 'utf8');
      expect(source).not.toBe(INVENTORY);
      expect(source.split(MARKER)).toHaveLength(3);
      expect(source).toContain("import {useWebMCPTool} from 'react-webmcp';");
      expect(source).toContain("name: 'add_item',");
      expect(source).toContain(
        'execute: ({sku, quantity}) => addItem(sku, quantity),',
      );
      expect(source).toContain("name: 'clear_cart',");
      expect(result.out).toContain('add   add_item -> App.js (Inventory)');
      expect(result.out).toContain(
        'Inserted 2 tool skeleton(s) into 1 file(s); skipped 0.',
      );
      expect(result.out).toContain('run `yarn validate-tools` before shipping');

      // A second run finds the tools already defined and changes nothing.
      stdout = [];
      expect(
        (await run(['emit', '--accepted', accepted, '--write'])).code,
      ).toBe(0);
      expect(fs.readFileSync(app, 'utf8')).toBe(source);
      expect(stdout.join('')).toContain(
        'skip  add_item (App.js#Inventory.addItem): already defined in App.js',
      );
      expect(stdout.join('')).toContain(
        'Inserted 0 tool skeleton(s) into 0 file(s); skipped 2.',
      );
    });

    it('emit rejects --write together with --dry-run, and needs --accepted', async () => {
      const {proposals} = await extractSample();
      let result = await run([
        'emit',
        '--accepted',
        proposals,
        '--write',
        '--dry-run',
      ]);
      expect(result.code).toBe(1);
      expect(result.err).toContain(
        'pass either --write or --dry-run, not both',
      );

      result = await run(['emit']);
      expect(result.code).toBe(1);
      expect(result.err).toContain('emit needs --accepted');
    });

    it('emit says so when nothing is accepted', async () => {
      const {app, proposals} = await extractSample();
      const result = await run(['emit', '--accepted', proposals, '--write']);
      expect(result.code).toBe(0);
      expect(result.out).toContain('No accepted proposals in');
      expect(result.out).toContain('nothing to do.');
      expect(fs.readFileSync(app, 'utf8')).toBe(INVENTORY);
    });

    it('emit finds the source directory of a ReviewExport from the sibling proposals file', async () => {
      const {app, proposals} = await extractSample();
      const file = readJson(proposals);
      const review = {
        version: 1,
        exportedAt: '2026-11-01T00:00:00.000Z',
        accepted: file.proposals.map(proposal => ({
          ...proposal,
          status: 'accepted',
        })),
        rejected: [],
      };
      // Next to tools.proposals.json, whose source.dir says where the owner
      // files live.
      const next = writeJson(path.join(tmp, 'review.json'), review);
      let result = await run(['emit', '--accepted', next, '--write']);
      expect(result.code).toBe(0);
      expect(fs.readFileSync(app, 'utf8')).toContain(MARKER);

      // Elsewhere, with no proposals file and no --src, the owner file is
      // looked for under the working directory and not found.
      const alone = writeJson(path.join(tmp, 'alone', 'review.json'), review);
      stdout = [];
      stderr = [];
      result = await run(['emit', '--accepted', alone]);
      expect(result.code).toBe(1);
      expect(result.err).toContain(
        'error: App.js was not found under ' + process.cwd(),
      );
      expect(result.err).toContain('pass --src <dir>');
      expect(result.out).toContain(
        'skip  add_item (App.js#Inventory.addItem): file not found',
      );

      // --src says where to look.
      writeSource('other/App.js', INVENTORY);
      stdout = [];
      result = await run([
        'emit',
        '--accepted',
        alone,
        '--src',
        path.join(tmp, 'other'),
        '--write',
      ]);
      expect(result.code).toBe(0);
      expect(
        fs.readFileSync(path.join(tmp, 'other', 'App.js'), 'utf8'),
      ).toContain(MARKER);
    });

    it('emit --evals lists eval skeletons in a dry run and writes them with --write', async () => {
      const {proposals} = await extractSample();
      const accepted = acceptAll(proposals, path.join(tmp, 'accepted.json'));
      const evals = path.join(tmp, 'evals');
      let result = await run([
        'emit',
        '--accepted',
        accepted,
        '--evals',
        evals,
      ]);
      expect(result.code).toBe(0);
      expect(fs.existsSync(evals)).toBe(false);
      expect(result.out).toContain(
        'evals 3 file(s) would be written to ' +
          path.relative(process.cwd(), evals) +
          ': add_item.eval.json, clear_cart.eval.json, README.md',
      );

      stdout = [];
      result = await run([
        'emit',
        '--accepted',
        accepted,
        '--evals',
        evals,
        '--write',
      ]);
      expect(result.code).toBe(0);
      expect(fs.readdirSync(evals).sort()).toEqual([
        'README.md',
        'add_item.eval.json',
        'clear_cart.eval.json',
      ]);
      expect(readJson(path.join(evals, 'clear_cart.eval.json'))).toEqual({
        messages: [{role: 'user', content: 'Clear cart.'}],
        expectedCall: [{functionName: 'clear_cart', arguments: {}}],
      });
      expect(result.out).toContain('evals 3 file(s) written to');

      // A file the developer edited is kept until --force-evals.
      const edited = path.join(evals, 'add_item.eval.json');
      fs.writeFileSync(edited, '{"edited": true}\n');
      stdout = [];
      result = await run([
        'emit',
        '--accepted',
        accepted,
        '--evals',
        evals,
        '--write',
      ]);
      expect(result.code).toBe(0);
      expect(fs.readFileSync(edited, 'utf8')).toBe('{"edited": true}\n');
      expect(result.out).toContain(
        'evals 0 file(s) written to ' +
          path.relative(process.cwd(), evals) +
          '; kept 3 existing (pass --force-evals to overwrite)',
      );

      stdout = [];
      result = await run([
        'emit',
        '--accepted',
        accepted,
        '--evals',
        evals,
        '--write',
        '--force-evals',
      ]);
      expect(result.code).toBe(0);
      expect(readJson(edited).expectedCall[0].functionName).toBe('add_item');
      expect(result.out).toContain('evals 3 file(s) written to');
    });
  });
});
