/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

'use strict';

// Bring-your-own provider: `--provider ./my-provider.js` loads a module from
// disk. The module may export, directly or as `default`:
//
//   {name, complete(request)}             the smallest form: turn one
//                                          LLMRequest ({system, prompt,
//                                          schema}) into the JSON text the
//                                          model produced; batching, the
//                                          prompt and validation stay here
//   {name, synthesize(proposals, context)} a full provider
//   (options) => one of the above          a factory; receives {model,
//                                          baseURL, warn} from the CLI
//
// Nothing in the module needs to import from this package.

import type {ToolProposal} from '../../src/ReactWebMCPProposalTypes';
import type {SynthesizeContext, SynthesizeProvider} from '../synthesize.flow';

const path = require('path');

const {synthesizeWithModel} = require('./llm.flow');

export type ProviderModuleOptions = {
  cwd: string,
  model?: string,
  baseURL?: string,
  warn?: (message: string) => void,
};

const SHAPE =
  'must export {name, complete(request)}, ' +
  '{name, synthesize(proposals, context)}, or a function returning one of those';

function isProviderPath(spec: string): boolean {
  return (
    spec.startsWith('./') ||
    spec.startsWith('../') ||
    path.isAbsolute(spec) ||
    /\.(c|m)?js$/.test(spec)
  );
}

function toProvider(
  candidate: mixed,
  spec: string,
  options: ProviderModuleOptions,
  depth: number,
): SynthesizeProvider {
  if (typeof candidate === 'function' && depth === 0) {
    const factory: any = candidate;
    const built = factory({
      model: options.model,
      baseURL: options.baseURL,
      warn: options.warn,
    });
    return toProvider(built, spec, options, depth + 1);
  }
  if (candidate != null && typeof candidate === 'object') {
    const object: {[string]: mixed} = candidate as any;
    const name =
      typeof object.name === 'string' && object.name !== ''
        ? object.name
        : spec;
    const synthesize: any = object.synthesize;
    if (typeof synthesize === 'function') {
      return {
        name,
        synthesize: (
          proposals: Array<ToolProposal>,
          context: SynthesizeContext,
        ) => Promise.resolve(synthesize.call(candidate, proposals, context)),
      };
    }
    const complete: any = object.complete;
    if (typeof complete === 'function') {
      const warn: (message: string) => void =
        options.warn != null
          ? options.warn
          : (message: string) => {
              process.stderr.write(message + '\n');
            };
      const batchSize =
        typeof object.batchSize === 'number' ? object.batchSize : undefined;
      return {
        name,
        synthesize: (
          proposals: Array<ToolProposal>,
          context: SynthesizeContext,
        ) =>
          synthesizeWithModel(proposals, context, {
            name,
            complete: request =>
              Promise.resolve(complete.call(candidate, request)),
            warn,
            batchSize,
          }),
      };
    }
  }
  throw new Error(`provider module ${spec} ${SHAPE}`);
}

function loadProviderModule(
  spec: string,
  options: ProviderModuleOptions,
): SynthesizeProvider {
  const file = path.resolve(options.cwd, spec);
  let loaded: any;
  try {
    // $FlowFixMe[unsupported-syntax]: the path is the user's.
    loaded = require(file);
  } catch (error) {
    throw new Error(`could not load provider module ${spec}: ${error.message}`);
  }
  const candidate =
    loaded != null && loaded.__esModule === true && loaded.default != null
      ? loaded.default
      : loaded;
  return toProvider(candidate, spec, options, 0);
}

module.exports = {isProviderPath, loadProviderModule};
