/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

'use strict';

// `infer trace`: grounds a proposals file against a running page.
//
// It opens the fixture (or a running app) the same way the contract check
// does, then records two kinds of evidence on every proposal:
//
//   - `mounted`: whether the proposal's owning component is in the component
//     tree React DevTools sees, so a reviewer knows the handler is reachable
//     on this page.
//   - `replay`: for tools that are already registered and read-only, the
//     result of calling them through `document.modelContext.executeTool`.
//     Mutating tools and proposals that are not tools yet are left pending,
//     with the reason spelled out; nothing here changes app state on purpose.
//
// Journey ("CUJ") traces are not recorded yet; the `trace` evidence row stays
// pending until that lands.

const fs = require('fs');
const path = require('path');

const {
  DEFAULT_FIXTURE_DIR,
  callTool,
  createError,
  evaluate,
  formatValue,
  log,
  openSession,
  readRegisteredNames,
} = require('../validate/run.flow');

import type {Chrome} from '../validate/run.flow';
import type {
  ProposalEvidence,
  ProposalsFile,
  ToolProposal,
} from '../src/ReactWebMCPProposalTypes';

export type TraceOptions = {
  in: string,
  out: string | null,
  url: string | null,
  fixtureDir: string,
  help: boolean,
};

type ReplayResult =
  | {ok: true, length: number, preview: string}
  | {ok: false, error: string};

function parseTraceArgs(argv: Array<string>): TraceOptions {
  const options: TraceOptions = {
    in: '',
    out: null,
    url: null,
    fixtureDir: DEFAULT_FIXTURE_DIR,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--in':
        options.in = path.resolve(argv[++i]);
        break;
      case '--out':
        options.out = path.resolve(argv[++i]);
        break;
      case '--url':
        options.url = argv[++i];
        break;
      case '--fixture':
        options.fixtureDir = path.resolve(argv[++i]);
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw createError(`Unknown argument for trace: ${arg}`);
    }
  }
  return options;
}

function printTraceHelp(): void {
  process.stdout.write(
    [
      'yarn infer-tools trace --in <tools.proposals.json> [--out <file>]',
      '                       [--url <running app url>] [--fixture <dir>]',
      '',
      'Opens the fixture (or --url) in headless Chrome through',
      'chrome-devtools-mcp and records, on every proposal, whether its owning',
      'component is mounted and, for registered read-only tools, what calling',
      'them returns. Writes the proposals file back in place unless --out is',
      'given.',
      '',
    ].join('\n'),
  );
}

function readProposalsFile(file: string): ProposalsFile {
  if (file === '') {
    throw createError('trace needs --in <tools.proposals.json>.');
  }
  let parsed: any;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw createError(`Could not read ${file}: ${error.message}`);
  }
  if (parsed == null || !Array.isArray(parsed.proposals)) {
    throw createError(
      `${file} is not a proposals file (no "proposals" array).`,
    );
  }
  return parsed as ProposalsFile;
}

// Replaces the evidence row for `check`, or appends one.
function setEvidence(
  proposal: ToolProposal,
  evidence: ProposalEvidence,
): ToolProposal {
  const next = proposal.evidence.filter(item => item.check !== evidence.check);
  next.push(evidence);
  return {...proposal, evidence: next};
}

async function readMountedComponents(chrome: Chrome): Promise<Set<string>> {
  const tree: any = await callTool(chrome, 'react_get_component_tree', {
    depth: 200,
  });
  const nodes = tree != null && Array.isArray(tree.nodes) ? tree.nodes : [];
  const names = new Set<string>();
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node != null && typeof node.name === 'string') {
      names.add(node.name);
    }
  }
  return names;
}

// Calls each named tool with no input, through the native API when the page
// has it (it wants the registered tool object) or through the shim.
async function replayTools(
  chrome: Chrome,
  names: Array<string>,
): Promise<{[string]: ReplayResult}> {
  if (names.length === 0) {
    return {};
  }
  const result = await evaluate(
    chrome,
    `async () => {
      const names = ${JSON.stringify(names)};
      const mc = document.modelContext;
      const out = {};
      if (mc == null) {
        for (const name of names) {
          out[name] = {ok: false, error: 'no document.modelContext'};
        }
        return out;
      }
      const native = mc.__isShim !== true && typeof mc.getTools === 'function';
      const registered = native ? Array.from(await mc.getTools()) : null;
      for (const name of names) {
        try {
          let value;
          if (native) {
            const tool = registered.find(candidate => candidate.name === name);
            if (tool == null) {
              throw new Error('not registered');
            }
            value = await mc.executeTool(tool, {});
          } else {
            value = await mc.executeTool(name, {});
          }
          const text = typeof value === 'string' ? value : JSON.stringify(value);
          out[name] = {
            ok: true,
            length: text == null ? 0 : text.length,
            preview: (text == null ? '' : text).slice(0, 80),
          };
        } catch (error) {
          out[name] = {
            ok: false,
            error: '' + ((error && error.message) || error),
          };
        }
      }
      return out;
    }`,
  );
  if (result == null || typeof result !== 'object') {
    throw createError(`Unexpected replay result: ${formatValue(result)}`);
  }
  return result as any;
}

function pagePathOf(appUrl: string): string {
  try {
    return new URL(appUrl).pathname || '/';
  } catch (error) {
    return appUrl;
  }
}

function takesNoRequiredInput(proposal: ToolProposal): boolean {
  const schema = proposal.inputSchema;
  return schema == null || schema.required.length === 0;
}

function applyTrace(
  file: ProposalsFile,
  mounted: Set<string>,
  registeredNames: Array<string>,
  replays: {[string]: ReplayResult},
  pageUrl: string,
): ProposalsFile {
  const registered = new Set(registeredNames);
  const proposals = file.proposals.map(original => {
    let proposal = original;
    const component = proposal.binding.component;
    if (component == null) {
      proposal = setEvidence(proposal, {
        check: 'mounted',
        level: 'pending',
        summary: 'no owning component to look for',
      });
    } else if (mounted.has(component)) {
      proposal = setEvidence(proposal, {
        check: 'mounted',
        level: 'ok',
        summary: `owner ${component} mounted on ${pageUrl}`,
      });
    } else {
      proposal = setEvidence(proposal, {
        check: 'mounted',
        level: 'warn',
        summary: `owner ${component} not mounted on ${pageUrl}`,
      });
    }

    const isRegistered = registered.has(proposal.qualifiedName);
    if (!isRegistered) {
      proposal = setEvidence(proposal, {
        check: 'replay',
        level: 'pending',
        summary:
          proposal.status === 'exported'
            ? 'not registered on this page'
            : 'replay runs once the tool exists',
      });
    } else if (proposal.safety !== 'read') {
      proposal = setEvidence(proposal, {
        check: 'replay',
        level: 'pending',
        summary: `not replayed: ${proposal.safety} tool`,
      });
    } else if (!takesNoRequiredInput(proposal)) {
      proposal = setEvidence(proposal, {
        check: 'replay',
        level: 'pending',
        summary: 'not replayed: requires input',
      });
    } else {
      const replay = replays[proposal.qualifiedName];
      if (replay == null) {
        proposal = setEvidence(proposal, {
          check: 'replay',
          level: 'pending',
          summary: 'not replayed',
        });
      } else if (replay.ok === true) {
        proposal = setEvidence(proposal, {
          check: 'replay',
          level: 'ok',
          summary: `executeTool returned ${replay.length} chars: "${replay.preview}"`,
        });
      } else {
        proposal = setEvidence(proposal, {
          check: 'replay',
          level: 'bad',
          summary: `executeTool threw: ${replay.error}`,
        });
      }
    }
    return proposal;
  });
  return {...file, proposals};
}

async function runTrace(argv: Array<string>): Promise<number> {
  const options = parseTraceArgs(argv);
  if (options.help) {
    printTraceHelp();
    return 0;
  }
  const file = readProposalsFile(options.in);
  const session = await openSession({
    url: options.url,
    fixtureDir: options.fixtureDir,
  });
  try {
    log('Reading the component tree...');
    const mounted = await readMountedComponents(session.chrome);
    const registeredNames = await readRegisteredNames(session.chrome);
    const replayable = file.proposals
      .filter(
        proposal =>
          registeredNames.indexOf(proposal.qualifiedName) !== -1 &&
          proposal.safety === 'read' &&
          takesNoRequiredInput(proposal),
      )
      .map(proposal => proposal.qualifiedName);
    log(
      `Replaying ${replayable.length} read-only tool(s): ${
        replayable.join(', ') || '(none)'
      }`,
    );
    const replays = await replayTools(session.chrome, replayable);
    const traced = applyTrace(
      file,
      mounted,
      registeredNames,
      replays,
      // The path, not the host: the fixture runs on a random port and the
      // proposals file is committed.
      pagePathOf(session.appUrl),
    );
    const out = options.out == null ? options.in : options.out;
    fs.writeFileSync(out, JSON.stringify(traced, null, 2) + '\n');
    let mountedCount = 0;
    let replayedOk = 0;
    traced.proposals.forEach(proposal => {
      proposal.evidence.forEach(item => {
        if (item.check === 'mounted' && item.level === 'ok') {
          mountedCount++;
        }
        if (item.check === 'replay' && item.level === 'ok') {
          replayedOk++;
        }
      });
    });
    log(
      `Traced ${traced.proposals.length} proposal(s): ${mountedCount} with a ` +
        `mounted owner, ${replayedOk} replayed. Wrote ${path.relative(
          process.cwd(),
          out,
        )}.`,
    );
    return 0;
  } finally {
    await session.close();
  }
}

module.exports = {applyTrace, parseTraceArgs, runTrace};
