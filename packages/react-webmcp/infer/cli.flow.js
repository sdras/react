/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

'use strict';

// The react-webmcp inference assistant.
//
//   yarn infer-tools extract    --src <dir> [--out <file>] [--route-from …]
//   yarn infer-tools synthesize --in <file> [--out <file>] [--provider …] [--model …]
//   yarn infer-tools trace      --in <file> [--out <file>] [--url …] [--fixture …]
//   yarn infer-tools emit       --accepted <file> [--src <dir>] [--write]
//
// Proposals go through a human review (`react-webmcp/unstable_review`) between
// `extract` and `emit`; nothing in this tool publishes a tool on its own.

import type {
  ProposalsFile,
  ToolProposal,
} from '../src/ReactWebMCPProposalTypes';

const fs = require('fs');
const path = require('path');

const {extractFromDirectory} = require('./extract.flow');
const {
  getProvider,
  resolveProviderName,
  synthesizeProposals,
} = require('./synthesize.flow');
const {loadAccepted, planEmit, unifiedDiff, writeEmit} = require('./emit.flow');

type FlagSpec = {[name: string]: 'string' | 'boolean'};
type Flags = {[name: string]: string | boolean};

const ROUTE_FROM_VALUES = ['path', 'scope', 'component'];

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

function warn(message: string): void {
  process.stderr.write(`${message}\n`);
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function usageError(message: string): Error {
  const error: any = new Error(message);
  error.usage = true;
  return error;
}

function parseFlags(args: Array<string>, spec: FlagSpec): Flags {
  const flags: Flags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.indexOf('--') !== 0) {
      throw usageError(`Unexpected argument: ${arg}`);
    }
    let key = arg.slice(2);
    let value = null;
    const equals = key.indexOf('=');
    if (equals !== -1) {
      value = key.slice(equals + 1);
      key = key.slice(0, equals);
    }
    const kind = spec[key];
    if (kind === undefined) {
      throw usageError(`Unknown flag --${key}`);
    }
    if (kind === 'boolean') {
      flags[key] = true;
      continue;
    }
    if (value == null) {
      i++;
      if (i >= args.length) {
        throw usageError(`--${key} needs a value`);
      }
      value = args[i];
    }
    flags[key] = value;
  }
  return flags;
}

function stringFlag(flags: Flags, name: string): string | null {
  const value = flags[name];
  return typeof value === 'string' ? value : null;
}

function requireFlag(flags: Flags, name: string, command: string): string {
  const value = stringFlag(flags, name);
  if (value == null) {
    throw usageError(`${command} needs --${name}`);
  }
  return value;
}

function readJson(file: string): any {
  if (!fs.existsSync(file)) {
    throw usageError(`${file} does not exist`);
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw usageError(`${file} is not valid JSON: ${error.message}`);
  }
}

function readProposalsFile(file: string): ProposalsFile {
  const json = readJson(file);
  if (
    json == null ||
    typeof json !== 'object' ||
    json.version !== 1 ||
    !Array.isArray(json.proposals)
  ) {
    throw usageError(`${file} is not a version 1 proposals file`);
  }
  return json;
}

function writeJson(file: string, value: mixed): void {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const json = JSON.stringify(value, null, 2);
  fs.writeFileSync(file, (json == null ? '' : json) + '\n');
}

function relativeToCwd(file: string): string {
  const relative = path.relative(process.cwd(), file);
  return relative === '' ? '.' : relative;
}

function formatProposal(proposal: ToolProposal): string {
  const binding = proposal.binding;
  const owner = `${binding.component == null ? '-' : binding.component}${
    binding.handler == null ? '' : '.' + binding.handler
  }`;
  return `  ${pad(proposal.status, 9)} ${pad(proposal.safety, 13)} ${pad(
    proposal.qualifiedName,
    30,
  )} ${pad(proposal.route, 16)} ${binding.file}:${binding.line}  ${owner}`;
}

function countByStatus(proposals: Array<ToolProposal>): string {
  const counts: Map<string, number> = new Map();
  for (let i = 0; i < proposals.length; i++) {
    const status = proposals[i].status;
    counts.set(status, (counts.get(status) || 0) + 1);
  }
  const parts: Array<string> = [];
  counts.forEach((count, status) => {
    parts.push(`${count} ${status}`);
  });
  return parts.join(', ');
}

/** Commands */

async function runExtract(args: Array<string>): Promise<number> {
  const flags = parseFlags(args, {
    src: 'string',
    out: 'string',
    'route-from': 'string',
  });
  const src = requireFlag(flags, 'src', 'extract');
  const routeFrom = stringFlag(flags, 'route-from') || 'path';
  if (ROUTE_FROM_VALUES.indexOf(routeFrom) === -1) {
    throw usageError(
      `--route-from must be one of ${ROUTE_FROM_VALUES.join(', ')}`,
    );
  }
  const out = path.resolve(
    stringFlag(flags, 'out') || path.join(src, '..', 'tools.proposals.json'),
  );
  const file = extractFromDirectory(src, {
    routeFrom: routeFrom as any,
    onWarning: message => warn(`warning: ${message}`),
  });
  writeJson(out, file);
  log(`Analyzed ${file.source.files.length} file(s) under ${file.source.dir}`);
  for (let i = 0; i < file.proposals.length; i++) {
    log(formatProposal(file.proposals[i]));
  }
  log(
    `Wrote ${file.proposals.length} proposal(s) (${countByStatus(
      file.proposals,
    )}) to ${relativeToCwd(out)}`,
  );
  log('Review them before anything ships; nothing is published automatically.');
  return 0;
}

async function runSynthesize(args: Array<string>): Promise<number> {
  const flags = parseFlags(args, {
    in: 'string',
    out: 'string',
    provider: 'string',
    model: 'string',
    'base-url': 'string',
  });
  const input = path.resolve(requireFlag(flags, 'in', 'synthesize'));
  const out = path.resolve(stringFlag(flags, 'out') || input);
  const providerName = resolveProviderName(
    stringFlag(flags, 'provider'),
    process.env,
  );
  const provider = getProvider(providerName, {
    model: stringFlag(flags, 'model'),
    baseURL: stringFlag(flags, 'base-url'),
    cwd: process.cwd(),
  });
  const file = readProposalsFile(input);
  const result = await synthesizeProposals(file, provider);
  writeJson(out, result.file);
  for (let i = 0; i < result.touched.length; i++) {
    const proposal = result.touched[i];
    log(`  ${pad(proposal.qualifiedName, 30)} ${proposal.description}`);
  }
  log(
    `${provider.name}: described ${result.touched.length} proposal(s); wrote ${relativeToCwd(
      out,
    )}`,
  );
  return 0;
}

function findSourceDirNextTo(acceptedFile: string): string | null {
  const sibling = path.join(path.dirname(acceptedFile), 'tools.proposals.json');
  if (!fs.existsSync(sibling)) {
    return null;
  }
  try {
    const json = JSON.parse(fs.readFileSync(sibling, 'utf8'));
    return json != null &&
      json.source != null &&
      typeof json.source.dir === 'string'
      ? json.source.dir
      : null;
  } catch (error) {
    return null;
  }
}

async function runEmit(args: Array<string>): Promise<number> {
  const flags = parseFlags(args, {
    accepted: 'string',
    src: 'string',
    write: 'boolean',
    'dry-run': 'boolean',
    evals: 'string',
    'force-evals': 'boolean',
  });
  const acceptedFile = path.resolve(requireFlag(flags, 'accepted', 'emit'));
  const write = flags.write === true;
  if (write && flags['dry-run'] === true) {
    throw usageError('pass either --write or --dry-run, not both');
  }
  const loaded = loadAccepted(readJson(acceptedFile));
  let srcDir = stringFlag(flags, 'src');
  if (srcDir == null) {
    srcDir = loaded.sourceDir;
  }
  if (srcDir == null) {
    srcDir = findSourceDirNextTo(acceptedFile);
  }
  if (srcDir == null) {
    srcDir = process.cwd();
  }
  srcDir = path.resolve(srcDir);
  if (loaded.accepted.length === 0) {
    log(
      `No accepted proposals in ${relativeToCwd(acceptedFile)}; nothing to do.`,
    );
    return 0;
  }
  const plans = planEmit(loaded.accepted, {srcDir});
  const evalsDir = stringFlag(flags, 'evals');
  if (evalsDir != null) {
    const {planEvals, writeEvals} = require('./evals.flow');
    const evalFiles = planEvals(loaded.accepted);
    if (write) {
      const result = writeEvals(path.resolve(evalsDir), evalFiles, {
        force: flags['force-evals'] === true,
      });
      log(
        `  evals ${result.written.length} file(s) written to ${relativeToCwd(
          path.resolve(evalsDir),
        )}${
          result.kept.length > 0
            ? `; kept ${result.kept.length} existing (pass --force-evals to overwrite)`
            : ''
        }`,
      );
    } else {
      log(
        `  evals ${evalFiles.length} file(s) would be written to ${relativeToCwd(
          path.resolve(evalsDir),
        )}: ${evalFiles.map(file => file.file).join(', ')}`,
      );
    }
  }
  let failed = 0;
  let insertedCount = 0;
  let skippedCount = 0;
  for (let i = 0; i < plans.length; i++) {
    const plan = plans[i];
    for (let j = 0; j < plan.skipped.length; j++) {
      const skipped = plan.skipped[j];
      log(`  skip  ${skipped.name} (${skipped.id}): ${skipped.reason}`);
    }
    skippedCount += plan.skipped.length;
    if (plan.error != null) {
      failed++;
      warn(`error: ${plan.error}`);
      continue;
    }
    for (let j = 0; j < plan.inserted.length; j++) {
      const inserted = plan.inserted[j];
      log(
        `  ${write ? 'add ' : 'plan'}  ${inserted.name} -> ${plan.file} (${inserted.component})`,
      );
    }
    insertedCount += plan.inserted.length;
    if (!write && plan.after !== plan.before) {
      log('');
      log(unifiedDiff(plan.file, plan.before, plan.after));
    }
  }
  if (write) {
    const written = writeEmit(plans);
    log(
      `Inserted ${insertedCount} tool skeleton(s) into ${written.length} file(s); skipped ${skippedCount}.`,
    );
    if (written.length > 0) {
      log(
        'Each insertion is marked with a comment; review it, fill in the TODOs, and run `yarn validate-tools` before shipping.',
      );
    }
  } else {
    log(
      `Dry run: ${insertedCount} tool skeleton(s) would be inserted into ${
        plans.filter(plan => plan.after !== plan.before).length
      } file(s); skipped ${skippedCount}. Pass --write to apply.`,
    );
  }
  return failed > 0 ? 1 : 0;
}

function printHelp(): void {
  log(
    [
      'react-webmcp inference assistant',
      '',
      'Usage: yarn infer-tools <command> [flags]',
      '',
      'Commands:',
      '  extract     Propose agent tools from the handlers and forms in a source tree',
      '              --src <dir>                 Directory to analyze (required)',
      '              --out <file>                Proposals file (default <src>/../tools.proposals.json)',
      '              --route-from path|scope|component',
      '                                          How to group proposals (default path)',
      '  synthesize  Write better names and descriptions for proposed tools',
      '              --in <file>                 Proposals file (required)',
      '              --out <file>                Output file (default: in place)',
      '              --provider fixture|anthropic|gemini|openai|./my-provider.js',
      '                                          Also read from REACT_WEBMCP_LLM (default fixture);',
      '                                          openai covers any chat-completions endpoint, a path',
      '                                          loads your own module (see infer/README.md)',
      '              --model <id>                The model to use (overrides the provider default)',
      '              --base-url <url>            openai: the endpoint (default https://api.openai.com/v1)',
      '  trace       Ground proposals against a running page (mounted/replay evidence)',
      '              --in <file>                 Proposals file (required)',
      '              --out <file>                Output file (default: in place)',
      '              --url <url>                 A running app to trace instead of starting the fixture',
      '              --fixture <dir>             Fixture directory (default fixtures/webmcp)',
      '  emit        Insert marked useWebMCPTool skeletons for accepted proposals',
      '              --accepted <file>           A ReviewExport or a proposals file (required)',
      "              --src <dir>                 Where the owner files live (default: the proposals' source.dir)",
      '              --write                     Apply the edits (default: print a diff)',
      '              --dry-run                   Print a diff only (the default)',
      '              --evals <dir>               Also write evals-cli skeletons, one per accepted tool',
      '              --force-evals               Overwrite eval files you have edited',
      '',
      'Nothing here publishes a tool. Proposals are reviewed by a person, and emit',
      'only writes skeletons marked for review.',
    ].join('\n'),
  );
}

async function main(argv: Array<string>): Promise<number> {
  const command = argv[0];
  const rest = argv.slice(1);
  try {
    switch (command) {
      case 'extract':
        return await runExtract(rest);
      case 'synthesize':
        return await runSynthesize(rest);
      case 'trace':
        // Owned by trace.flow.js; it parses its own flags.
        return await require('./trace.flow').runTrace(rest);
      case 'emit':
        return await runEmit(rest);
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        printHelp();
        return 0;
      default:
        throw usageError(`Unknown command: ${command}`);
    }
  } catch (error) {
    warn(`infer-tools: ${error.message}`);
    if (error.usage === true) {
      warn('Run `yarn infer-tools help` for usage.');
    }
    return 1;
  }
}

module.exports = {main, parseFlags};
