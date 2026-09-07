/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

'use strict';

// The react-webmcp contract check.
//
// Drives the webmcp fixture through chrome-devtools-mcp, reads the tools React
// owns via `react_get_agent_tools`, and verifies that they are grounded:
//
//   1. Binding existence: every tool resolves to an owning component with a
//      source location.
//   2. Registration cross-check: the tools reported as registered are exactly
//      the tools the browser (or the fixture's modelContext shim) holds.
//   3. Suspense behavior: tools inside a suspended boundary are unavailable
//      and unregistered, then return.
//   4. Schema/handler agreement: each tool's inputSchema declares the
//      parameters its execute function reads (static analysis of the owner's
//      source file).
//   5. Budgets and safety: names, descriptions and parameter descriptions stay
//      within the sizes agents tolerate; names are unique; read-only tools do
//      not look like mutations.
//   6. Drift: the tool surface matches the committed manifest
//      (`--update` rewrites it).
//
// Usage: node packages/react-webmcp/validate/run.js [--update] [--fixture <dir>]
//        [--manifest <file>] [--url <running fixture url>] [--skip-static]
//        [--skip-suspense]

const assert = require('assert');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const {checkToolAgainstSource} = require('./staticCheck');

type ChildProcess = any;
type CommandResult = {stdout: string, stderr: string};
type SpawnOptions = {
  cwd: string,
  detached?: boolean,
  env: {[string]: string | void},
  logFile: string,
};
type CommandOptions = {
  cwd: string,
  env: {[string]: string | void},
  logFile: string,
  timeout?: number,
};
type Chrome = {
  pageId: number,
  run: (args: Array<string>) => Promise<CommandResult>,
  json: (args: Array<string>) => Promise<mixed>,
};
type AgentTool = {
  key: string,
  qualifiedName: string,
  name: string,
  scopePath: Array<string>,
  description: string,
  inputSchema: mixed,
  annotations: {[string]: mixed},
  safety: string | null,
  lifetime: string,
  source: string,
  status: string,
  availability: {[string]: boolean},
  error: string | null,
  owner: {uid: string, name: string, type: string} | null,
  ownerSource: {
    name: string,
    fileName: string,
    line: number,
    column: number,
  } | null,
  unresolvedReason?: string,
};
type Collected = {
  registryFound: boolean,
  tools: Array<AgentTool>,
  registeredNames: Array<string>,
};
type ManifestEntry = {
  qualifiedName: string,
  name: string,
  scopePath: Array<string>,
  description: string,
  inputSchema: mixed,
  annotations: {[string]: mixed},
  safety: string | null,
  lifetime: string,
  source: string,
  owner: {name: string} | null,
};
type Finding = {
  level: 'error' | 'warn' | 'info',
  check: string,
  tool: string | null,
  message: string,
};
type Options = {
  update: boolean,
  fixtureDir: string,
  manifestPath: string,
  url: string | null,
  skipStatic: boolean,
  skipSuspense: boolean,
  help: boolean,
};

const PACKAGE_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(PACKAGE_DIR, '..', '..');
const DEFAULT_FIXTURE_DIR = path.join(REPO_ROOT, 'fixtures', 'webmcp');
const BUILT_MODULES_DIR = path.join(REPO_ROOT, 'build', 'oss-experimental');
const LOG_DIR =
  process.env.VALIDATE_LOG_DIR ||
  path.join(REPO_ROOT, 'tmp', 'react-webmcp-validate');
const SESSION_ID = crypto.randomUUID();

// Budgets from Chrome's WebMCP guidance (kept in sync with
// src/ReactWebMCPValidation.js).
const MAX_NAME_LENGTH = 30;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_PARAM_DESCRIPTION_LENGTH = 150;
const MUTATING_PREFIXES = [
  'add_',
  'create_',
  'delete_',
  'remove_',
  'clear_',
  'update_',
  'set_',
  'submit_',
];

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function createError(message: string): Error {
  return new Error(message);
}

function formatValue(value: mixed): string {
  const json = JSON.stringify(value);
  return json === undefined ? typeof value : json;
}

function parseArgs(argv: Array<string>): Options {
  const options: Options = {
    update: false,
    fixtureDir: DEFAULT_FIXTURE_DIR,
    manifestPath: '',
    url: null,
    skipStatic: false,
    skipSuspense: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--update':
        options.update = true;
        break;
      case '--fixture':
        options.fixtureDir = path.resolve(argv[++i]);
        break;
      case '--manifest':
        options.manifestPath = path.resolve(argv[++i]);
        break;
      case '--url':
        options.url = argv[++i];
        break;
      case '--skip-static':
        options.skipStatic = true;
        break;
      case '--skip-suspense':
        options.skipSuspense = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw createError(`Unknown argument: ${arg}`);
    }
  }
  if (options.manifestPath === '') {
    options.manifestPath = path.join(options.fixtureDir, 'tools.manifest.json');
  }
  return options;
}

/** Process helpers (same shape as the react-devtools-cdt-mcp e2e runner) */

function ensureBuiltModules(): void {
  if (!fs.existsSync(path.join(BUILT_MODULES_DIR, 'react-webmcp'))) {
    throw createError(
      'Missing build/oss-experimental/react-webmcp. Run ' +
        '`yarn build-for-devtools` from the repo root before running the ' +
        'react-webmcp contract check.'
    );
  }
}

function ensureFixtureDependencies(fixtureDir: string): void {
  if (!fs.existsSync(path.join(fixtureDir, 'node_modules'))) {
    throw createError(
      `The fixture at ${fixtureDir} has no node_modules. Run ` +
        '`yarn install` inside it first.'
    );
  }
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', undefined, () => {
      const address = server.address();
      if (address == null || typeof address === 'string') {
        reject(createError('Failed to allocate a TCP port'));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

function appendLog(logFile: string, text: string | Buffer): void {
  fs.appendFileSync(logFile, text);
}

function formatCommand(command: string, args: Array<string>): string {
  return `$ ${[command, ...args].map(arg => JSON.stringify(arg)).join(' ')}\n`;
}

function spawnLogged(
  command: string,
  args: Array<string>,
  options: SpawnOptions
): ChildProcess {
  const child = childProcess.spawn(command, args, {
    cwd: options.cwd,
    detached: options.detached === true,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  appendLog(options.logFile, formatCommand(command, args));
  child.on('error', error => {
    appendLog(
      options.logFile,
      `Failed to spawn ${command}: ${error.stack || error.message}\n`
    );
  });
  child.stdout.on('data', chunk => appendLog(options.logFile, chunk));
  child.stderr.on('data', chunk => appendLog(options.logFile, chunk));
  return child;
}

function waitForExit(child: ChildProcess, timeout: number): Promise<void> {
  return new Promise(resolve => {
    let done = false;
    const finish = () => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      if (child.exitCode == null) {
        child.kill('SIGKILL');
      }
      finish();
    }, timeout);
    if (child.exitCode != null) {
      finish();
      return;
    }
    child.once('exit', finish);
    child.once('error', finish);
  });
}

function runCommand(
  command: string,
  args: Array<string>,
  options: CommandOptions
): Promise<CommandResult> {
  const timeout = options.timeout || 120000;
  const logFile = options.logFile;
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    appendLog(logFile, formatCommand(command, args));
    const child = childProcess.spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(createError(`Command timed out after ${timeout}ms: ${command}`));
    }, timeout);
    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
      appendLog(logFile, chunk);
    });
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
      appendLog(logFile, chunk);
    });
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({stdout, stderr});
      } else {
        reject(
          createError(
            `Command failed with exit code ${
              code == null ? 'null' : code
            }: ${command} ${args.join(' ')}\n${stderr || stdout}`
          )
        );
      }
    });
  });
}

function startDebuggableChrome(
  chromeExecutablePath: string,
  remoteDebuggingPort: number,
  logFile: string
): {profileDir: string, process: ChildProcess} {
  const profileDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'react-webmcp-validate-chrome-')
  );
  appendLog(logFile, `chromeUserDataDir=${profileDir}\n`);
  const args = [
    '--headless=new',
    `--remote-debugging-port=${remoteDebuggingPort}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ];
  if (process.platform === 'linux') {
    args.splice(1, 0, '--no-sandbox', '--disable-setuid-sandbox');
  }
  return {
    profileDir,
    process: spawnLogged(chromeExecutablePath, args, {
      cwd: PACKAGE_DIR,
      env: process.env,
      logFile,
    }),
  };
}

function getChromeDevToolsBin(): string {
  let packageJsonPath: string;
  try {
    packageJsonPath = require.resolve('chrome-devtools-mcp/package.json', {
      paths: [PACKAGE_DIR, REPO_ROOT],
    });
  } catch (error) {
    throw createError(
      'Missing chrome-devtools-mcp dependency. Run `yarn install` from the ' +
        'repo root before running the react-webmcp contract check.'
    );
  }
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const bin =
    packageJson != null && packageJson.bin != null
      ? packageJson.bin['chrome-devtools']
      : null;
  if (typeof bin !== 'string') {
    throw createError(
      'chrome-devtools-mcp package.json is missing the chrome-devtools bin'
    );
  }
  return path.resolve(path.dirname(packageJsonPath), bin);
}

async function waitForHttp(url: string, timeout: number): Promise<void> {
  const deadline = Date.now() + timeout;
  let lastError: Error = createError('No response yet');
  while (Date.now() < deadline) {
    try {
      const statusCode: number = await new Promise((resolve, reject) => {
        const request = http.get(url, (response: any) => {
          response.resume();
          response.on('end', () => resolve(response.statusCode || 0));
        });
        request.on('error', reject);
        request.setTimeout(1000, () => {
          request.destroy(createError('HTTP request timed out'));
        });
      });
      if (statusCode >= 200 && statusCode < 400) {
        return;
      }
      lastError = createError(`HTTP ${statusCode}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw createError(`Timed out waiting for ${url}: ${lastError.message}`);
}

/** chrome-devtools-mcp CLI output parsing */

function parseJsonOutput(stdout: string): mixed {
  const text = stdout.trim();
  assert.notStrictEqual(text, '', 'Expected command to print JSON');
  const parsed = JSON.parse(text);
  if (
    Array.isArray(parsed) &&
    parsed.length === 1 &&
    parsed[0] &&
    parsed[0].type === 'text' &&
    typeof parsed[0].text === 'string'
  ) {
    throw createError(parsed[0].text);
  }
  return parsed;
}

function unwrapTextResponse(response: mixed): string {
  if (Array.isArray(response)) {
    return response.join('\n');
  }
  if (typeof response === 'string') {
    return response;
  }
  if (response != null && typeof response === 'object') {
    const message = (response as any).message;
    if (typeof message === 'string') {
      return message;
    }
  }
  return formatValue(response);
}

function parseJsonFromText(text: string): mixed {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```json\n([\s\S]*?)\n```/);
  if (fenced) {
    return JSON.parse(fenced[1]);
  }
  return JSON.parse(trimmed);
}

function parsePageId(value: mixed): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value;
  }
  if (value == null || typeof value !== 'object') {
    return null;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const pageId = parsePageId(value[index]);
      if (pageId != null) {
        return pageId;
      }
    }
    return null;
  }
  const object: any = value;
  if (object.pages != null) {
    const pageId = parsePageId(object.pages);
    if (pageId != null) {
      return pageId;
    }
  }
  if (object.pageId != null) {
    const pageId = parsePageId(object.pageId);
    if (pageId != null) {
      return pageId;
    }
  }
  if (object.id != null) {
    return parsePageId(object.id);
  }
  return null;
}

async function resolvePageId(chrome: Chrome): Promise<number> {
  const pages = await chrome.json(['list_pages']);
  const pageId = parsePageId(pages);
  if (pageId == null) {
    throw createError(
      `Expected list_pages to include a page id. Saw: ${formatValue(pages)}`
    );
  }
  return pageId;
}

async function evaluate(chrome: Chrome, fn: string): Promise<mixed> {
  const output = await chrome.json([
    'evaluate_script',
    fn,
    '--pageId',
    `${chrome.pageId}`,
  ]);
  return parseJsonFromText(unwrapTextResponse(output));
}

async function callTool(
  chrome: Chrome,
  toolName: string,
  params?: {...}
): Promise<mixed> {
  const output = await chrome.json([
    'execute_3p_developer_tool',
    `${chrome.pageId}`,
    toolName,
    '--params',
    JSON.stringify(params || {}),
  ]);
  return parseJsonFromText(unwrapTextResponse(output));
}

async function waitForPageReady(
  chrome: Chrome,
  timeout: number
): Promise<void> {
  const deadline = Date.now() + timeout;
  let lastResult: mixed = null;
  while (Date.now() < deadline) {
    const result: any = await evaluate(
      chrome,
      `() => ({
        hasApp: document.querySelector('main.app') !== null,
        hasHook: window.__REACT_DEVTOOLS_GLOBAL_HOOK__ != null,
        hasRegistry: window.__REACT_WEBMCP__ != null,
      })`
    );
    lastResult = result;
    if (
      result != null &&
      result.hasApp === true &&
      result.hasHook === true &&
      result.hasRegistry === true
    ) {
      return;
    }
    await sleep(250);
  }
  throw createError(
    `Timed out waiting for the fixture to be ready: ${formatValue(lastResult)}`
  );
}

/** Collection */

async function readRegisteredNames(chrome: Chrome): Promise<Array<string>> {
  const result = await evaluate(
    chrome,
    `async () => {
      if (window.__WEBMCP_SHIM__) {
        return window.__WEBMCP_SHIM__.names();
      }
      if (document.modelContext && document.modelContext.getTools) {
        const tools = await document.modelContext.getTools();
        return tools.map(tool => tool.name).sort();
      }
      return null;
    }`
  );
  if (!Array.isArray(result)) {
    throw createError(
      `Could not read the registered tool names from the page. Saw: ${formatValue(
        result
      )}`
    );
  }
  return result.map(name =>
    typeof name === 'string' ? name : JSON.stringify(name) || ''
  );
}

async function collect(chrome: Chrome): Promise<Collected> {
  const agentTools: any = await callTool(chrome, 'react_get_agent_tools');
  if (agentTools == null || typeof agentTools !== 'object') {
    throw createError(
      `Unexpected react_get_agent_tools result: ${formatValue(agentTools)}`
    );
  }
  if (typeof agentTools.error === 'string') {
    throw createError(`react_get_agent_tools failed: ${agentTools.error}`);
  }
  const tools: Array<AgentTool> = Array.isArray(agentTools.tools)
    ? agentTools.tools
    : [];
  const registeredNames = await readRegisteredNames(chrome);
  return {
    registryFound: agentTools.registryFound === true,
    tools,
    registeredNames,
  };
}

/** Checks */

function finding(
  level: 'error' | 'warn' | 'info',
  check: string,
  tool: string | null,
  message: string
): Finding {
  return {level, check, tool, message};
}

function checkRegistry(collected: Collected): Array<Finding> {
  if (!collected.registryFound) {
    return [
      finding(
        'error',
        'registry',
        null,
        'The page does not expose the react-webmcp registry. Is this a ' +
          'development build that uses react-webmcp?'
      ),
    ];
  }
  if (collected.tools.length === 0) {
    return [
      finding('error', 'registry', null, 'The registry contains no tools.'),
    ];
  }
  return [];
}

async function checkBindings(
  chrome: Chrome,
  collected: Collected
): Promise<Array<Finding>> {
  const findings = [];
  for (let i = 0; i < collected.tools.length; i++) {
    const tool = collected.tools[i];
    if (tool.owner == null) {
      findings.push(
        finding(
          'error',
          'binding',
          tool.qualifiedName,
          `No owning component could be resolved${
            tool.unresolvedReason != null ? ': ' + tool.unresolvedReason : '.'
          }`
        )
      );
      continue;
    }
    const owner = tool.owner;
    if (tool.ownerSource == null) {
      findings.push(
        finding(
          'error',
          'binding',
          tool.qualifiedName,
          `The owner ${owner.name} (${owner.uid}) has no source location.`
        )
      );
      continue;
    }
    const source: any = await callTool(chrome, 'react_get_component_source', {
      uid: owner.uid,
    });
    if (source == null || source.source == null) {
      findings.push(
        finding(
          'error',
          'binding',
          tool.qualifiedName,
          `react_get_component_source could not resolve owner uid ${owner.uid}.`
        )
      );
    }
  }
  return findings;
}

function checkRegistrationCrossCheck(collected: Collected): Array<Finding> {
  const expected = collected.tools
    .filter(tool => tool.status === 'registered')
    .map(tool => tool.qualifiedName)
    .sort();
  const actual = collected.registeredNames.slice().sort();
  if (JSON.stringify(expected) === JSON.stringify(actual)) {
    return [];
  }
  const missing = expected.filter(name => actual.indexOf(name) === -1);
  const extra = actual.filter(name => expected.indexOf(name) === -1);
  return [
    finding(
      'error',
      'registration',
      null,
      `Registered tools differ from the registry. Missing from the browser: [${missing.join(
        ', '
      )}]. In the browser but not registered by React: [${extra.join(', ')}].`
    ),
  ];
}

function checkBudgets(collected: Collected): Array<Finding> {
  const findings = [];
  const seen: Map<string, number> = new Map();
  for (let i = 0; i < collected.tools.length; i++) {
    const tool = collected.tools[i];
    seen.set(tool.qualifiedName, (seen.get(tool.qualifiedName) || 0) + 1);
    if (tool.qualifiedName.length > MAX_NAME_LENGTH) {
      findings.push(
        finding(
          'warn',
          'budget',
          tool.qualifiedName,
          `The name is ${tool.qualifiedName.length} characters; agents may truncate names over ${MAX_NAME_LENGTH}.`
        )
      );
    }
    if (tool.description.length > MAX_DESCRIPTION_LENGTH) {
      findings.push(
        finding(
          'warn',
          'budget',
          tool.qualifiedName,
          `The description is ${tool.description.length} characters; keep it under ${MAX_DESCRIPTION_LENGTH}.`
        )
      );
    }
    const schema: any = tool.inputSchema;
    if (schema != null && schema.properties != null) {
      const keys = Object.keys(schema.properties);
      for (let j = 0; j < keys.length; j++) {
        const property = schema.properties[keys[j]];
        if (
          property != null &&
          typeof property.description === 'string' &&
          property.description.length > MAX_PARAM_DESCRIPTION_LENGTH
        ) {
          findings.push(
            finding(
              'warn',
              'budget',
              tool.qualifiedName,
              `The description of parameter "${keys[j]}" is over ${MAX_PARAM_DESCRIPTION_LENGTH} characters.`
            )
          );
        }
      }
    }
    if (tool.safety == null) {
      findings.push(
        finding(
          'warn',
          'safety',
          tool.qualifiedName,
          'No safety classification. Agents assume mutation; mark read-only tools "read" and destructive ones "irreversible".'
        )
      );
    } else if (tool.safety === 'read') {
      for (let j = 0; j < MUTATING_PREFIXES.length; j++) {
        if (tool.name.indexOf(MUTATING_PREFIXES[j]) === 0) {
          findings.push(
            finding(
              'warn',
              'safety',
              tool.qualifiedName,
              `Marked "read" but named like a mutation ("${tool.name}").`
            )
          );
          break;
        }
      }
    }
  }
  seen.forEach((count, name) => {
    if (count > 1) {
      findings.push(
        finding(
          'error',
          'budget',
          name,
          `${count} tools share this agent-facing name.`
        )
      );
    }
  });
  return findings;
}

// Maps a source file name reported by the page back to a file in the fixture.
function resolveSourceFile(
  fileName: string,
  fixtureDir: string
): string | null {
  let relative: string | null = null;
  if (fileName.indexOf('webpack-internal:///') === 0) {
    relative = fileName.slice('webpack-internal:///'.length);
  } else if (fileName.indexOf('webpack://') === 0) {
    const index = fileName.indexOf('/./');
    if (index !== -1) {
      relative = fileName.slice(index + 1);
    }
  } else if (path.isAbsolute(fileName)) {
    return fs.existsSync(fileName) ? fileName : null;
  }
  if (relative == null) {
    return null;
  }
  relative = relative.split('?')[0];
  const candidate = path.resolve(fixtureDir, relative);
  return fs.existsSync(candidate) ? candidate : null;
}

function checkStatic(collected: Collected, fixtureDir: string): Array<Finding> {
  const findings = [];
  const sources: Map<string, string> = new Map();
  for (let i = 0; i < collected.tools.length; i++) {
    const tool = collected.tools[i];
    const owner = tool.owner;
    const ownerSource = tool.ownerSource;
    if (ownerSource == null || owner == null) {
      continue;
    }
    const file = resolveSourceFile(ownerSource.fileName, fixtureDir);
    if (file == null) {
      findings.push(
        finding(
          'info',
          'static',
          tool.qualifiedName,
          `Skipped: the source file name "${ownerSource.fileName}" could not be mapped to a file in the fixture.`
        )
      );
      continue;
    }
    let source = sources.get(file);
    if (source === undefined) {
      source = fs.readFileSync(file, 'utf8');
      sources.set(file, source);
    }
    const result = checkToolAgainstSource(source, {
      toolName: tool.name,
      componentName: owner.name,
    });
    const where = `${path.relative(REPO_ROOT, file)}${
      result.line != null ? ':' + result.line : ''
    }`;
    if (result.status === 'ok') {
      continue;
    }
    if (result.status === 'mismatch') {
      const parts = [];
      if (result.usedButUndeclared.length > 0) {
        parts.push(
          `execute reads [${result.usedButUndeclared.join(
            ', '
          )}] but inputSchema does not declare them`
        );
      }
      if (result.requiredButUnused.length > 0) {
        parts.push(
          `inputSchema requires [${result.requiredButUnused.join(
            ', '
          )}] but execute never reads them`
        );
      }
      if (result.declaredButUnused.length > 0) {
        parts.push(
          `declared but unused: [${result.declaredButUnused.join(', ')}]`
        );
      }
      findings.push(
        finding(
          'error',
          'static',
          tool.qualifiedName,
          `${where}: ${parts.join('; ')}.`
        )
      );
    } else if (result.status === 'skipped') {
      findings.push(
        finding(
          'info',
          'static',
          tool.qualifiedName,
          `${where}: skipped (${result.reason})`
        )
      );
    } else {
      findings.push(
        finding(
          'warn',
          'static',
          tool.qualifiedName,
          `${path.relative(REPO_ROOT, file)}: ${result.reason}`
        )
      );
    }
  }
  return findings;
}

function flattenSnapshot(node: any, result: Array<any>): Array<any> {
  result.push(node);
  const children = Array.isArray(node.children) ? node.children : [];
  for (let i = 0; i < children.length; i++) {
    flattenSnapshot(children[i], result);
  }
  return result;
}

async function findButtonUid(chrome: Chrome, name: string): Promise<string> {
  const response: any = await chrome.json([
    'take_snapshot',
    `${chrome.pageId}`,
  ]);
  const snapshot = response != null ? response.snapshot : null;
  if (snapshot == null) {
    throw createError(
      `take_snapshot returned no snapshot: ${formatValue(response)}`
    );
  }
  const node = flattenSnapshot(snapshot, []).find(
    candidate => candidate.role === 'button' && candidate.name === name
  );
  if (node == null || typeof node.id !== 'string') {
    throw createError(
      `Could not find a "${name}" button in the page snapshot.`
    );
  }
  return node.id;
}

async function pollUntil(
  chrome: Chrome,
  predicate: (collected: Collected) => boolean,
  timeout: number
): Promise<Collected> {
  const deadline = Date.now() + timeout;
  let last = await collect(chrome);
  while (!predicate(last) && Date.now() < deadline) {
    await sleep(250);
    last = await collect(chrome);
  }
  return last;
}

async function checkSuspense(
  chrome: Chrome,
  collected: Collected
): Promise<Array<Finding>> {
  const cartTools = collected.tools.filter(
    tool => tool.source === 'tree' && tool.scopePath.indexOf('cart') !== -1
  );
  if (cartTools.length === 0) {
    return [
      finding(
        'info',
        'suspense',
        null,
        'Skipped: no tree-path tools in the "cart" scope to exercise.'
      ),
    ];
  }
  const names = cartTools.map(tool => tool.qualifiedName);
  const allUnavailable = (state: Collected) =>
    names.every(name => {
      const tool = state.tools.find(
        candidate => candidate.qualifiedName === name
      );
      return (
        tool != null &&
        tool.status === 'unavailable' &&
        state.registeredNames.indexOf(name) === -1
      );
    });
  const allRegistered = (state: Collected) =>
    names.every(name => {
      const tool = state.tools.find(
        candidate => candidate.qualifiedName === name
      );
      return (
        tool != null &&
        tool.status === 'registered' &&
        state.registeredNames.indexOf(name) !== -1
      );
    });

  const findings = [];
  const suspendUid = await findButtonUid(chrome, 'Suspend cart');
  await chrome.json(['click', `${chrome.pageId}`, suspendUid]);
  const suspended = await pollUntil(chrome, allUnavailable, 10000);
  if (!allUnavailable(suspended)) {
    findings.push(
      finding(
        'error',
        'suspense',
        null,
        `After suspending the cart, expected [${names.join(
          ', '
        )}] to be unavailable and unregistered. Saw statuses ${formatValue(
          suspended.tools
            .filter(tool => names.indexOf(tool.qualifiedName) !== -1)
            .map(tool => [tool.qualifiedName, tool.status])
        )} and registered names ${formatValue(suspended.registeredNames)}.`
      )
    );
  }
  const resumeUid = await findButtonUid(chrome, 'Resume cart');
  await chrome.json(['click', `${chrome.pageId}`, resumeUid]);
  const resumed = await pollUntil(chrome, allRegistered, 10000);
  if (!allRegistered(resumed)) {
    findings.push(
      finding(
        'error',
        'suspense',
        null,
        `After resuming the cart, expected [${names.join(
          ', '
        )}] to be registered again. Saw registered names ${formatValue(
          resumed.registeredNames
        )}.`
      )
    );
  }
  return findings;
}

function projectForManifest(tools: Array<AgentTool>): Array<ManifestEntry> {
  return tools
    .map(tool => ({
      qualifiedName: tool.qualifiedName,
      name: tool.name,
      scopePath: tool.scopePath,
      description: tool.description,
      inputSchema: tool.inputSchema === undefined ? null : tool.inputSchema,
      annotations: tool.annotations,
      safety: tool.safety,
      lifetime: tool.lifetime,
      source: tool.source,
      owner: tool.owner == null ? null : {name: tool.owner.name},
    }))
    .sort((a, b) =>
      a.qualifiedName < b.qualifiedName
        ? -1
        : a.qualifiedName > b.qualifiedName
          ? 1
          : 0
    );
}

function simpleDiff(expected: string, actual: string): string {
  const expectedLines = expected.split('\n');
  const actualLines = actual.split('\n');
  const lines = [];
  const max = Math.max(expectedLines.length, actualLines.length);
  for (let i = 0; i < max && lines.length < 60; i++) {
    const e = expectedLines[i];
    const a = actualLines[i];
    if (e !== a) {
      if (e !== undefined) {
        lines.push(`- ${e}`);
      }
      if (a !== undefined) {
        lines.push(`+ ${a}`);
      }
    }
  }
  return lines.join('\n');
}

function checkDrift(collected: Collected, options: Options): Array<Finding> {
  const projection = projectForManifest(collected.tools);
  const manifest = {
    version: 1,
    note:
      'Generated by `yarn validate-tools --update`. Review changes to this ' +
      'file like any other change to the agent-facing surface.',
    tools: projection,
  };
  const serialized = JSON.stringify(manifest, null, 2) + '\n';
  const exists = fs.existsSync(options.manifestPath);
  if (options.update || !exists) {
    fs.mkdirSync(path.dirname(options.manifestPath), {recursive: true});
    fs.writeFileSync(options.manifestPath, serialized);
    return [
      finding(
        exists ? 'info' : 'warn',
        'drift',
        null,
        `${exists ? 'Updated' : 'Created'} ${path.relative(
          REPO_ROOT,
          options.manifestPath
        )} with ${projection.length} tools.`
      ),
    ];
  }
  const existing = fs.readFileSync(options.manifestPath, 'utf8');
  if (existing === serialized) {
    return [];
  }
  return [
    finding(
      'error',
      'drift',
      null,
      `The tool surface differs from ${path.relative(
        REPO_ROOT,
        options.manifestPath
      )}. Review the change and run \`yarn validate-tools --update\` to accept it.\n${simpleDiff(
        existing,
        serialized
      )}`
    ),
  ];
}

function report(findings: Array<Finding>): number {
  const errors = findings.filter(f => f.level === 'error');
  const warnings = findings.filter(f => f.level === 'warn');
  const infos = findings.filter(f => f.level === 'info');
  const print = (items: Array<Finding>, label: string) => {
    if (items.length === 0) {
      return;
    }
    log(`\n${label}`);
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      log(
        `  [${item.check}]${item.tool != null ? ' ' + item.tool : ''}: ${
          item.message
        }`
      );
    }
  };
  print(errors, `${errors.length} error(s)`);
  print(warnings, `${warnings.length} warning(s)`);
  print(infos, `${infos.length} note(s)`);
  if (errors.length === 0) {
    log('\nreact-webmcp contract check passed.');
    return 0;
  }
  log('\nreact-webmcp contract check failed.');
  return 1;
}

async function runChecks(
  chrome: Chrome,
  options: Options
): Promise<Array<Finding>> {
  log('Reading the agent tools React owns...');
  const collected = await collect(chrome);
  log(
    `Found ${collected.tools.length} tool(s): ${collected.tools
      .map(tool => `${tool.qualifiedName} (${tool.status})`)
      .join(', ')}`
  );
  let findings = checkRegistry(collected);
  if (findings.length > 0) {
    return findings;
  }
  findings = findings.concat(await checkBindings(chrome, collected));
  findings = findings.concat(checkRegistrationCrossCheck(collected));
  findings = findings.concat(checkBudgets(collected));
  if (!options.skipStatic) {
    findings = findings.concat(checkStatic(collected, options.fixtureDir));
  }
  if (!options.skipSuspense) {
    findings = findings.concat(await checkSuspense(chrome, collected));
  }
  findings = findings.concat(checkDrift(collected, options));
  return findings;
}

function printHelp(): void {
  log(
    [
      'react-webmcp contract check',
      '',
      'Usage: node packages/react-webmcp/validate/run.js [options]',
      '',
      '  --update            Rewrite the manifest with the current tool surface',
      '  --fixture <dir>     Fixture directory (default fixtures/webmcp)',
      '  --manifest <file>   Manifest path (default <fixture>/tools.manifest.json)',
      '  --url <url>         Check an already running fixture instead of starting one',
      '  --skip-static       Skip the schema/handler source check',
      '  --skip-suspense     Skip the Suspense availability check',
    ].join('\n')
  );
}

async function main(argv: Array<string>): Promise<number> {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return 0;
  }
  if (options.url == null) {
    ensureBuiltModules();
    ensureFixtureDependencies(options.fixtureDir);
  }
  fs.mkdirSync(LOG_DIR, {recursive: true});
  const fixtureLog = path.join(LOG_DIR, 'fixture-server.log');
  const chromeLog = path.join(LOG_DIR, 'chrome-devtools.log');
  const cliLog = path.join(LOG_DIR, 'chrome-devtools-cli.log');
  fs.writeFileSync(fixtureLog, '');
  fs.writeFileSync(chromeLog, '');
  fs.writeFileSync(cliLog, '');

  const chromeDevToolsBin = getChromeDevToolsBin();
  let appUrl = options.url;
  let fixture: ?ChildProcess;
  let debuggableChrome: ?ChildProcess;
  let debuggableChromeProfile: ?string;

  const runChrome = (args: Array<string>): Promise<CommandResult> =>
    runCommand(
      process.execPath,
      [chromeDevToolsBin, ...args, '--sessionId', SESSION_ID],
      {cwd: PACKAGE_DIR, env: process.env, logFile: cliLog, timeout: 120000}
    );
  const chrome: Chrome = {
    pageId: 1,
    run: runChrome,
    async json(args: Array<string>): Promise<mixed> {
      const result = await runChrome([...args, '--output-format', 'json']);
      return parseJsonOutput(result.stdout);
    },
  };

  try {
    if (appUrl == null) {
      const port = await getFreePort();
      appUrl = `http://127.0.0.1:${port}/`;
      log(`Starting the fixture at ${appUrl}`);
      fixture = spawnLogged('yarn', ['start'], {
        cwd: options.fixtureDir,
        detached: true,
        env: {
          ...process.env,
          BROWSER: 'none',
          CI: 'true',
          E2E: 'true',
          HOST: '127.0.0.1',
          PORT: `${port}`,
        },
        logFile: fixtureLog,
      });
      await waitForHttp(appUrl, 90000);
    }
    const startArgs = [
      'start',
      '--categoryExperimentalThirdParty=true',
      '--usageStatistics=false',
      '--logFile',
      chromeLog,
    ];
    const chromeExecutablePath = process.env.CHROME_EXECUTABLE_PATH;
    if (chromeExecutablePath != null) {
      const remoteDebuggingPort = await getFreePort();
      const launched = startDebuggableChrome(
        chromeExecutablePath,
        remoteDebuggingPort,
        chromeLog
      );
      debuggableChrome = launched.process;
      debuggableChromeProfile = launched.profileDir;
      const browserUrl = `http://127.0.0.1:${remoteDebuggingPort}`;
      await waitForHttp(`${browserUrl}/json/version`, 30000);
      startArgs.push('--browserUrl', browserUrl);
    } else {
      startArgs.push('--headless=true', '--isolated=true');
    }
    log('Starting the chrome-devtools daemon...');
    await chrome.run(startArgs);
    chrome.pageId = await resolvePageId(chrome);
    await chrome.json([
      'navigate_page',
      `${chrome.pageId}`,
      '--type',
      'url',
      '--url',
      appUrl,
    ]);
    await waitForPageReady(chrome, 30000);

    log('Checking third-party tool discovery...');
    const discovery: any = await chrome.json([
      'list_3p_developer_tools',
      `${chrome.pageId}`,
    ]);
    const groups =
      discovery != null ? discovery.thirdPartyDeveloperTools : null;
    const groupList = Array.isArray(groups)
      ? groups
      : groups != null
        ? [groups]
        : [];
    const reactGroup = groupList.find(
      group => group != null && group.name === 'react'
    );
    if (
      reactGroup == null ||
      !Array.isArray(reactGroup.tools) ||
      !reactGroup.tools.some(
        tool => tool != null && tool.name === 'react_get_agent_tools'
      )
    ) {
      throw createError(
        'react_get_agent_tools is not discoverable on this page. Is ' +
          'react-devtools-cdt-mcp/register imported before React?'
      );
    }

    const findings = await runChecks(chrome, options);
    return report(findings);
  } finally {
    try {
      await chrome.run(['stop']);
    } catch (error) {
      appendLog(cliLog, `Failed to stop chrome-devtools: ${error.stack}\n`);
    }
    if (debuggableChrome) {
      try {
        debuggableChrome.kill('SIGTERM');
        await waitForExit(debuggableChrome, 5000);
      } catch (error) {
        appendLog(chromeLog, `Failed to stop Chrome: ${error.stack}\n`);
      }
    }
    if (debuggableChromeProfile) {
      try {
        fs.rmSync(debuggableChromeProfile, {force: true, recursive: true});
      } catch (error) {
        appendLog(
          chromeLog,
          `Failed to remove the Chrome profile: ${error.stack}\n`
        );
      }
    }
    if (fixture && fixture.pid) {
      try {
        process.kill(-fixture.pid, 'SIGTERM');
      } catch (error) {
        try {
          fixture.kill('SIGTERM');
        } catch (innerError) {
          appendLog(
            fixtureLog,
            `Failed to stop the fixture: ${innerError.stack}\n`
          );
        }
      }
    }
  }
}

module.exports = {main, parseArgs, projectForManifest, resolveSourceFile};
