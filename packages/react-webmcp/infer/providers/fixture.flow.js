/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

'use strict';

// The deterministic synthesize provider. It writes a plain sentence from the
// tool name, its parameters and its owning component, so the pipeline can be
// exercised (and tested) without a network. A real provider replaces this with
// a model call that sees the handler's source.

import type {ToolProposal} from '../../src/ReactWebMCPProposalTypes';
import type {SynthesizeContext, SynthesizeProvider} from '../synthesize.flow';

const EVENT_PREFIXES = ['click', 'change', 'input', 'toggle'];
const CREATE_VERBS = [
  'add',
  'create',
  'insert',
  'register',
  'make',
  'new',
  'post',
  'open',
  'start',
];
const DESTRUCTIVE_VERBS = [
  'delete',
  'remove',
  'clear',
  'destroy',
  'reset',
  'purchase',
  'pay',
  'place',
  'checkout',
  'cancel',
  'publish',
  'send',
];

function capitalize(word: string): string {
  return word === '' ? '' : word.charAt(0).toUpperCase() + word.slice(1);
}

// `click_reload_inventory` (an anonymous handler named after its button) reads
// better as `reload_inventory`; two-word names such as `click_add` are kept
// because the remainder alone would be ambiguous.
function improveName(name: string): string {
  const words = name.split('_');
  if (EVENT_PREFIXES.indexOf(words[0]) !== -1 && words.length > 2) {
    return words.slice(1).join('_');
  }
  return name;
}

function articleFor(verb: string, object: string): string {
  if (CREATE_VERBS.indexOf(verb) !== -1) {
    if (/s$/.test(object) && !/ss$/.test(object)) {
      return '';
    }
    return /^[aeiou]/.test(object) ? 'an' : 'a';
  }
  return 'the';
}

function describeProposal(proposal: ToolProposal): ToolProposal {
  const name = improveName(proposal.name);
  const words = name.split('_');
  const verb = words[0];
  let object = words.slice(1).join(' ');
  if (proposal.binding.kind === 'form' && !/\bform$/.test(object)) {
    object = `${object} form`.trim();
  }
  const params =
    proposal.inputSchema != null
      ? Object.keys(proposal.inputSchema.properties)
      : proposal.binding.params;
  let sentence = capitalize(verb);
  if (object !== '') {
    const article = articleFor(verb, object);
    sentence += article === '' ? ` ${object}` : ` ${article} ${object}`;
  }
  if (params.length > 0) {
    sentence += ` (${params.join(', ')})`;
  }
  if (proposal.binding.component != null) {
    sentence += ` in ${proposal.binding.component}`;
  }
  sentence += '.';
  if (
    proposal.safety === 'irreversible' &&
    DESTRUCTIVE_VERBS.indexOf(verb) !== -1
  ) {
    sentence += ' This cannot be undone.';
  }
  return {...proposal, name, description: sentence};
}

function createFixtureProvider(): SynthesizeProvider {
  return {
    name: 'fixture',
    synthesize(
      proposals: Array<ToolProposal>,
      context: SynthesizeContext,
    ): Promise<Array<ToolProposal>> {
      return Promise.resolve(proposals.map(describeProposal));
    },
  };
}

module.exports = {createFixtureProvider, describeProposal, improveName};
