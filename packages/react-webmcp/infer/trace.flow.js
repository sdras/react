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
// does, then records evidence on every proposal:
//
//   - `mounted`: whether the proposal's owning component is in the component
//     tree React DevTools sees, so a reviewer knows the handler is reachable
//     on this page.
//   - `replay`: for tools that are already registered and read-only, the
//     result of calling them through `document.modelContext.executeTool`.
//     Mutating tools are replayed only inside a journey the developer wrote.
//   - `trace`: with `--journey <file>`, the page is driven through the
//     journey's steps (fill, click, tool, wait). Each click or fill is mapped
//     to the React components that own the element and, when possible, to the
//     handler that ran, so the proposals those steps exercised are marked.
//
// Nothing here changes app state unless a journey asks for it.

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
  journeys: Array<string>,
  help: boolean,
};

export type JourneyStep = {
  // Click the first button or link whose accessible name is this text...
  click?: string,
  // ...optionally the one nearest to an element containing this text.
  near?: string,
  // Type into the input found by placeholder, aria-label, label or name.
  fill?: string,
  value?: string,
  // Call a registered tool through document.modelContext.
  tool?: string,
  input?: {[string]: mixed},
  // Pause, in milliseconds.
  wait?: number,
};

export type Journey = {
  name: string,
  description?: string,
  steps: Array<JourneyStep>,
};

export type StepResult = {
  index: number,
  kind: 'click' | 'fill' | 'tool' | 'wait',
  label: string,
  ok: boolean,
  error: string | null,
  // Function components that own the element, nearest first.
  owners: Array<string>,
  // The handler the step ran, when its name could be read off the props.
  handler: string | null,
  // The start of that handler's source, so an anonymous arrow that forwards
  // to a named function can still be matched.
  handlerSource: string | null,
  // Whether the page text or the tool registry changed after the step.
  changed: boolean,
  // For tool steps: a preview of the result.
  output: string | null,
};

export type JourneyRun = {
  name: string,
  steps: Array<StepResult>,
};

type ReplayResult =
  | {ok: true, length: number, preview: string}
  | {ok: false, error: string};

const STEP_SETTLE_MS = 350;

function parseTraceArgs(argv: Array<string>): TraceOptions {
  const options: TraceOptions = {
    in: '',
    out: null,
    url: null,
    fixtureDir: DEFAULT_FIXTURE_DIR,
    journeys: [],
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
      case '--journey':
        options.journeys.push(path.resolve(argv[++i]));
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
      '                       [--journey <journey.json>]...',
      '',
      'Opens the fixture (or --url) in headless Chrome through',
      'chrome-devtools-mcp and records, on every proposal, whether its owning',
      'component is mounted and, for registered read-only tools, what calling',
      'them returns. With --journey, drives the page through the steps in the',
      'file ({"name", "steps": [{"fill", "value"}, {"click", "near"?},',
      '{"tool", "input"?}, {"wait"}]}) and marks the proposals each step',
      'exercised. Writes the proposals file back in place unless --out is',
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

function stepKind(step: JourneyStep): 'click' | 'fill' | 'tool' | 'wait' {
  if (typeof step.click === 'string') {
    return 'click';
  }
  if (typeof step.fill === 'string') {
    return 'fill';
  }
  if (typeof step.tool === 'string') {
    return 'tool';
  }
  if (typeof step.wait === 'number') {
    return 'wait';
  }
  throw createError(
    `A journey step needs one of click, fill, tool or wait: ${formatValue(step)}`,
  );
}

function readJourney(file: string): Journey {
  let parsed: any;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw createError(`Could not read journey ${file}: ${error.message}`);
  }
  if (parsed == null || !Array.isArray(parsed.steps)) {
    throw createError(`${file} is not a journey (no "steps" array).`);
  }
  const name =
    typeof parsed.name === 'string' && parsed.name !== ''
      ? parsed.name
      : path.basename(file, path.extname(file));
  parsed.steps.forEach(stepKind);
  return {name, description: parsed.description, steps: parsed.steps};
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

// The page-side helpers every journey step shares: finding elements by what
// the page shows, reading the React owners and handler of an element through
// the fiber React attaches to DOM nodes, and snapshotting the page so a step
// can report whether anything changed.
const PAGE_HELPERS = `
  const norm = value => (value == null ? '' : '' + value).replace(/\\s+/g, ' ').trim().toLowerCase();
  const hash = text => {
    let h = 0;
    for (let i = 0; i < text.length; i++) {
      h = (h * 31 + text.charCodeAt(i)) | 0;
    }
    return text.length + ':' + h;
  };
  const snapshot = () => ({
    text: hash(document.body ? document.body.innerText : ''),
    registry: JSON.stringify(
      window.__REACT_WEBMCP__
        ? window.__REACT_WEBMCP__.getTools().map(tool => tool.qualifiedName + ':' + tool.status)
        : []
    ),
  });
  const changedSince = before => {
    const after = snapshot();
    return after.text !== before.text || after.registry !== before.registry;
  };
  const settle = () => new Promise(resolve => setTimeout(resolve, ${STEP_SETTLE_MS}));
  const fiberOf = element => {
    const key = Object.keys(element).find(k => k.startsWith('__reactFiber$'));
    return key ? element[key] : null;
  };
  const componentName = type => {
    if (typeof type === 'function') {
      return type.displayName || type.name || null;
    }
    if (type != null && typeof type === 'object') {
      const inner = type.render || type.type;
      return (type.displayName || (inner && (inner.displayName || inner.name))) || null;
    }
    return null;
  };
  const handlerName = (fn, prop) => {
    if (typeof fn !== 'function') return null;
    const name = fn.name || '';
    // Inline arrows get the prop's name inferred from the object literal.
    return name === '' || name === prop || name === 'bound ' + prop ? null : name.replace(/^bound /, '');
  };
  const describe = (element, prop) => {
    const owners = [];
    let handler = null;
    let handlerSource = null;
    let fiber = fiberOf(element);
    while (fiber != null) {
      if (handlerSource == null && fiber.memoizedProps != null && typeof fiber.memoizedProps[prop] === 'function') {
        handler = handlerName(fiber.memoizedProps[prop], prop);
        handlerSource = fiber.memoizedProps[prop].toString().slice(0, 400);
      }
      const name = componentName(fiber.type);
      if (name != null && typeof fiber.type !== 'string' && owners.indexOf(name) === -1) {
        owners.push(name);
      }
      fiber = fiber.return;
    }
    return {owners, handler, handlerSource};
  };
  // Whether a node shows the text: in its text content, or in a placeholder,
  // aria-label or title of something inside it.
  const showsText = (node, text) => {
    const needle = norm(text);
    if (norm(node.textContent).indexOf(needle) !== -1) return true;
    return Array.from(node.querySelectorAll('[placeholder], [aria-label], [title]')).some(el =>
      [el.getAttribute('placeholder'), el.getAttribute('aria-label'), el.getAttribute('title')].some(
        value => value != null && norm(value).indexOf(needle) !== -1
      )
    );
  };
  // How close the element is to something showing the text: the size of the
  // nearest ancestor that shows it (smaller is closer), Infinity when none.
  const nearScore = (element, near) => {
    if (near == null) return 0;
    let node = element;
    while (node != null && node !== document.body) {
      if (showsText(node, near)) return (node.textContent || '').length;
      node = node.parentElement;
    }
    return Infinity;
  };
  const findClickable = (label, near) => {
    const all = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="submit"]'));
    const exact = all.filter(element =>
      norm(element.getAttribute('aria-label')) === norm(label) ||
      norm(element.textContent) === norm(label) ||
      norm(element.value) === norm(label)
    );
    const loose = all.filter(element => norm(element.textContent).indexOf(norm(label)) !== -1);
    const matches = exact.length > 0 ? exact : loose;
    if (near == null) return matches[0] || null;
    let best = null;
    let bestScore = Infinity;
    for (const element of matches) {
      const score = nearScore(element, near);
      if (score < bestScore) {
        best = element;
        bestScore = score;
      }
    }
    return best;
  };
  const findField = label => {
    const fields = Array.from(document.querySelectorAll('input, textarea, select'));
    const labelled = Array.from(document.querySelectorAll('label'))
      .filter(l => norm(l.textContent).indexOf(norm(label)) !== -1)
      .map(l => (l.htmlFor ? document.getElementById(l.htmlFor) : l.querySelector('input, textarea, select')))
      .filter(Boolean);
    return (
      fields.find(f => norm(f.getAttribute('placeholder')) === norm(label)) ||
      fields.find(f => norm(f.getAttribute('aria-label')) === norm(label)) ||
      fields.find(f => norm(f.getAttribute('name')) === norm(label)) ||
      labelled[0] ||
      null
    );
  };
`;

function stepScript(step: JourneyStep, kind: string): string {
  const stepJson = JSON.stringify(step);
  switch (kind) {
    case 'click':
      return `async () => {
        ${PAGE_HELPERS}
        const step = ${stepJson};
        const element = findClickable(step.click, step.near);
        if (element == null) {
          return {ok: false, error: 'no clickable element named "' + step.click + '"' + (step.near != null ? ' near "' + step.near + '"' : ''), owners: [], handler: null, changed: false};
        }
        let info = describe(element, 'onClick');
        if (info.handlerSource == null) {
          const form = element.closest('form');
          const isSubmit = form != null && (element.type === 'submit' || element.getAttribute('type') === 'submit');
          if (isSubmit) {
            const formInfo = describe(form, 'onSubmit');
            info = {owners: info.owners, handler: formInfo.handler == null ? 'onSubmit' : formInfo.handler, handlerSource: formInfo.handlerSource};
          }
        }
        const before = snapshot();
        element.click();
        await settle();
        return {ok: true, error: null, owners: info.owners, handler: info.handler, handlerSource: info.handlerSource, changed: changedSince(before)};
      }`;
    case 'fill':
      return `async () => {
        ${PAGE_HELPERS}
        const step = ${stepJson};
        const field = findField(step.fill);
        if (field == null) {
          return {ok: false, error: 'no field labelled "' + step.fill + '"', owners: [], handler: null, changed: false};
        }
        const info = describe(field, 'onChange');
        const before = snapshot();
        const prototype = field.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : field.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
        if (descriptor && descriptor.set) {
          descriptor.set.call(field, step.value == null ? '' : '' + step.value);
        } else {
          field.value = step.value == null ? '' : '' + step.value;
        }
        field.dispatchEvent(new Event('input', {bubbles: true}));
        field.dispatchEvent(new Event('change', {bubbles: true}));
        await settle();
        return {ok: true, error: null, owners: info.owners, handler: info.handler, handlerSource: info.handlerSource, changed: changedSince(before)};
      }`;
    case 'tool':
      return `async () => {
        ${PAGE_HELPERS}
        const step = ${stepJson};
        const mc = document.modelContext;
        if (mc == null) {
          return {ok: false, error: 'no document.modelContext', owners: [], handler: null, changed: false};
        }
        const before = snapshot();
        try {
          const native = mc.__isShim !== true && typeof mc.getTools === 'function';
          let value;
          if (native) {
            const tool = Array.from(await mc.getTools()).find(candidate => candidate.name === step.tool);
            if (tool == null) throw new Error('not registered');
            value = await mc.executeTool(tool, step.input == null ? {} : step.input);
          } else {
            value = await mc.executeTool(step.tool, step.input == null ? {} : step.input);
          }
          await settle();
          const text = typeof value === 'string' ? value : JSON.stringify(value);
          return {ok: true, error: null, owners: [], handler: null, changed: changedSince(before), output: (text == null ? '' : text).slice(0, 120)};
        } catch (error) {
          return {ok: false, error: '' + ((error && error.message) || error), owners: [], handler: null, changed: changedSince(before)};
        }
      }`;
    default:
      return `async () => {
        await new Promise(resolve => setTimeout(resolve, ${typeof step.wait === 'number' ? step.wait : 0}));
        return {ok: true, error: null, owners: [], handler: null, changed: false};
      }`;
  }
}

function stepLabel(step: JourneyStep, kind: string): string {
  switch (kind) {
    case 'click':
      return `click "${step.click != null ? step.click : ''}"${
        step.near != null ? ` near "${step.near}"` : ''
      }`;
    case 'fill':
      return `fill "${step.fill != null ? step.fill : ''}"`;
    case 'tool':
      return `tool ${step.tool != null ? step.tool : ''}`;
    default:
      return `wait ${typeof step.wait === 'number' ? step.wait : 0}ms`;
  }
}

async function runJourney(
  chrome: Chrome,
  journey: Journey,
): Promise<JourneyRun> {
  const results: Array<StepResult> = [];
  for (let i = 0; i < journey.steps.length; i++) {
    const step = journey.steps[i];
    const kind = stepKind(step);
    const label = stepLabel(step, kind);
    const raw: any = await evaluate(chrome, stepScript(step, kind));
    const result: StepResult = {
      index: i + 1,
      kind,
      label,
      ok: raw != null && raw.ok === true,
      error: raw != null && typeof raw.error === 'string' ? raw.error : null,
      owners:
        raw != null && Array.isArray(raw.owners)
          ? raw.owners.filter(name => typeof name === 'string')
          : [],
      handler:
        raw != null && typeof raw.handler === 'string' ? raw.handler : null,
      handlerSource:
        raw != null && typeof raw.handlerSource === 'string'
          ? raw.handlerSource
          : null,
      changed: raw != null && raw.changed === true,
      output: raw != null && typeof raw.output === 'string' ? raw.output : null,
    };
    results.push(result);
    log(
      `  ${journey.name} ${result.index}. ${label}: ${
        result.ok ? 'ok' : 'failed'
      }${result.error != null ? ` (${result.error})` : ''}${
        result.owners.length > 0
          ? ` in ${result.owners.slice(0, 2).join(' < ')}`
          : ''
      }${result.handler != null ? ` ran ${result.handler}` : ''}${
        result.changed ? ', page changed' : ''
      }`,
    );
    if (!result.ok) {
      break;
    }
  }
  return {name: journey.name, steps: results};
}

function takesNoRequiredInput(proposal: ToolProposal): boolean {
  const schema = proposal.inputSchema;
  return schema == null || schema.required.length === 0;
}

function pagePathOf(appUrl: string): string {
  try {
    return new URL(appUrl).pathname || '/';
  } catch (error) {
    return appUrl;
  }
}

// How strongly a step exercised a proposal: 2 when the handler that ran is
// the proposal's handler (by name, or an inline arrow whose source calls it,
// or its form's onSubmit), 1 when the step only touched the component that
// owns the proposal, 0 otherwise. A fill step counts only through its
// onChange handler, so typing does not credit every handler in a component.
function stepMatch(step: StepResult, proposal: ToolProposal): number {
  const binding = proposal.binding;
  if (
    step.kind === 'tool' ||
    step.kind === 'wait' ||
    binding.component == null ||
    step.owners.indexOf(binding.component) === -1
  ) {
    return 0;
  }
  const nearest = step.owners[0] === binding.component;
  const handlerSource = step.handlerSource;
  const forwarded =
    binding.handler != null &&
    step.handler == null &&
    handlerSource != null &&
    new RegExp('\\b' + binding.handler + '\\s*\\(').test(handlerSource);
  if (binding.kind === 'form') {
    if (step.kind !== 'click') {
      return 0;
    }
    return step.handler != null &&
      (step.handler === binding.handler || step.handler === 'onSubmit')
      ? 2
      : nearest
        ? 1
        : 0;
  }
  if (binding.kind !== 'handler') {
    return 0;
  }
  if (binding.handler != null) {
    if (step.handler === binding.handler || forwarded) {
      return 2;
    }
    return step.kind === 'click' && nearest ? 1 : 0;
  }
  if (step.kind !== 'click') {
    return 0;
  }
  // An inline handler is named after its element ("click_add"); an anonymous
  // step handler on that element in this component is as close as we get.
  const labelWords = step.label
    .replace(/^click "|"( near .*)?$/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_');
  return step.handler == null &&
    nearest &&
    proposal.name.indexOf(labelWords) !== -1
    ? 2
    : nearest
      ? 1
      : 0;
}

function applyJourneys(
  file: ProposalsFile,
  runs: Array<JourneyRun>,
): ProposalsFile {
  if (runs.length === 0) {
    return file;
  }
  const journeyNames = runs.map(run => run.name).join(', ');
  const proposals = file.proposals.map(original => {
    let proposal = original;
    let best = 0;
    let bestSummary = '';
    let toolRun: StepResult | null = null;
    let toolRunJourney = '';
    for (let i = 0; i < runs.length; i++) {
      const run = runs[i];
      for (let j = 0; j < run.steps.length; j++) {
        const step = run.steps[j];
        if (!step.ok) {
          continue;
        }
        if (
          step.kind === 'tool' &&
          step.label === `tool ${proposal.qualifiedName}`
        ) {
          toolRun = step;
          toolRunJourney = run.name;
          continue;
        }
        const score = stepMatch(step, proposal);
        if (score > best) {
          best = score;
          bestSummary =
            score === 2
              ? `journey ${run.name} step ${step.index}: ${step.label} ran ${
                  step.handler != null ? step.handler : 'this handler'
                }${step.changed ? ' and the page changed' : ''}`
              : `journey ${run.name} step ${step.index}: ${step.label} touched ${
                  proposal.binding.component != null
                    ? proposal.binding.component
                    : 'the owner'
                }, but which handler ran is unclear`;
        }
      }
    }
    if (best === 2) {
      proposal = setEvidence(proposal, {
        check: 'trace',
        level: 'ok',
        summary: bestSummary,
      });
    } else if (best === 1) {
      proposal = setEvidence(proposal, {
        check: 'trace',
        level: 'warn',
        summary: bestSummary,
      });
    } else {
      proposal = setEvidence(proposal, {
        check: 'trace',
        level: 'pending',
        summary: `not exercised by ${journeyNames}`,
      });
    }
    if (toolRun != null) {
      const output = toolRun.output != null ? toolRun.output : '';
      proposal = setEvidence(proposal, {
        check: 'replay',
        level: 'ok',
        summary: `journey ${toolRunJourney} step ${toolRun.index}: executeTool returned "${output.slice(
          0,
          80,
        )}"${toolRun.changed ? '; the page changed' : '; nothing visible changed'}`,
      });
    }
    return proposal;
  });
  return {...file, proposals};
}

function applyTrace(
  file: ProposalsFile,
  mounted: Set<string>,
  registeredNames: Array<string>,
  replays: {[string]: ReplayResult},
  pageUrl: string,
  runs?: Array<JourneyRun>,
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
        summary: `not replayed: ${proposal.safety} tool (add a journey step to run it)`,
      });
    } else if (!takesNoRequiredInput(proposal)) {
      proposal = setEvidence(proposal, {
        check: 'replay',
        level: 'pending',
        summary: 'not replayed: requires input (add a journey step to run it)',
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
  return applyJourneys({...file, proposals}, runs != null ? runs : []);
}

async function runTrace(argv: Array<string>): Promise<number> {
  const options = parseTraceArgs(argv);
  if (options.help) {
    printTraceHelp();
    return 0;
  }
  const file = readProposalsFile(options.in);
  const journeys = options.journeys.map(readJourney);
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
    const runs: Array<JourneyRun> = [];
    for (let i = 0; i < journeys.length; i++) {
      log(
        `Running journey ${journeys[i].name} (${journeys[i].steps.length} steps)...`,
      );
      runs.push(await runJourney(session.chrome, journeys[i]));
    }
    const traced = applyTrace(
      file,
      mounted,
      registeredNames,
      replays,
      // The path, not the host: the fixture runs on a random port and the
      // proposals file is committed.
      pagePathOf(session.appUrl),
      runs,
    );
    const out = options.out == null ? options.in : options.out;
    fs.writeFileSync(out, JSON.stringify(traced, null, 2) + '\n');
    let mountedCount = 0;
    let replayedOk = 0;
    let exercised = 0;
    traced.proposals.forEach(proposal => {
      proposal.evidence.forEach(item => {
        if (item.check === 'mounted' && item.level === 'ok') {
          mountedCount++;
        }
        if (item.check === 'replay' && item.level === 'ok') {
          replayedOk++;
        }
        if (item.check === 'trace' && item.level === 'ok') {
          exercised++;
        }
      });
    });
    log(
      `Traced ${traced.proposals.length} proposal(s): ${mountedCount} with a ` +
        `mounted owner, ${replayedOk} replayed, ${exercised} exercised by a ` +
        `journey. Wrote ${path.relative(process.cwd(), out)}.`,
    );
    return 0;
  } finally {
    await session.close();
  }
}

module.exports = {
  applyJourneys,
  applyTrace,
  parseTraceArgs,
  readJourney,
  runTrace,
  stepMatch,
};
