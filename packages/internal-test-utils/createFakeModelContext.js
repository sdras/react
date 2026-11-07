/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

'use strict';

// A stand-in for `document.modelContext` that records registrations, honors
// the AbortSignal contract for unregistration, and can run tools.
//
// Options: `failFor` / `rejectFor` refuse every registration of that name,
// synchronously or with a rejected promise; `failOnceFor` / `rejectOnceFor`
// refuse only the first attempt, so a test can see a retry succeed.
// `attempts(name)` counts registerTool calls per name, refused ones included.
function createFakeModelContext(options = {}) {
  const tools = new Map();
  const log = [];
  const failFor = options.failFor || null;
  const rejectFor = options.rejectFor || null;
  const failOnceFor = options.failOnceFor || null;
  const rejectOnceFor = options.rejectOnceFor || null;
  const attemptCounts = new Map();
  return {
    tools,
    log,
    registerTool(tool, registerOptions) {
      const attempt = (attemptCounts.get(tool.name) || 0) + 1;
      attemptCounts.set(tool.name, attempt);
      if (
        (failFor !== null && tool.name === failFor) ||
        (failOnceFor !== null && tool.name === failOnceFor && attempt === 1)
      ) {
        throw new Error('Registration refused for ' + tool.name);
      }
      if (
        (rejectFor !== null && tool.name === rejectFor) ||
        (rejectOnceFor !== null && tool.name === rejectOnceFor && attempt === 1)
      ) {
        return Promise.reject(
          new Error('Async registration refused for ' + tool.name),
        );
      }
      log.push(['register', tool.name]);
      tools.set(tool.name, tool);
      const signal = registerOptions && registerOptions.signal;
      if (signal) {
        signal.addEventListener('abort', () => {
          if (tools.get(tool.name) === tool) {
            tools.delete(tool.name);
          }
          log.push(['abort', tool.name]);
        });
      }
      return undefined;
    },
    async executeTool(name, input, client) {
      const tool = tools.get(name);
      if (tool === undefined) {
        throw new Error('No tool named ' + name);
      }
      return tool.execute(input, client || {signal: null});
    },
    names() {
      return Array.from(tools.keys()).sort();
    },
    attempts(name) {
      return attemptCounts.get(name) || 0;
    },
    registrations() {
      return log.filter(entry => entry[0] === 'register').map(e => e[1]);
    },
  };
}

module.exports = {createFakeModelContext};
