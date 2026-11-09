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
// `pendingFor` answers with a promise that stays pending, and registers the
// tool, only when the test calls `resolveRegistration(name)`.
// `attempts(name)` counts registerTool calls per name, refused ones included.
function createFakeModelContext(options = {}) {
  const tools = new Map();
  const log = [];
  const failFor = options.failFor !== undefined ? options.failFor : null;
  const rejectFor = options.rejectFor !== undefined ? options.rejectFor : null;
  const failOnceFor =
    options.failOnceFor !== undefined ? options.failOnceFor : null;
  const rejectOnceFor =
    options.rejectOnceFor !== undefined ? options.rejectOnceFor : null;
  const pendingFor =
    options.pendingFor !== undefined ? options.pendingFor : null;
  const attemptCounts = new Map();
  const pendingResolvers = new Map();

  function install(tool, registerOptions) {
    const signal = registerOptions != null ? registerOptions.signal : undefined;
    if (signal != null && signal.aborted) {
      // Unregistered before the browser answered.
      return;
    }
    log.push(['register', tool.name]);
    tools.set(tool.name, tool);
    if (signal != null) {
      signal.addEventListener('abort', () => {
        if (tools.get(tool.name) === tool) {
          tools.delete(tool.name);
        }
        log.push(['abort', tool.name]);
      });
    }
  }

  return {
    tools,
    log,
    registerTool(tool, registerOptions) {
      const previousAttempts = attemptCounts.get(tool.name);
      const attempt =
        (previousAttempts === undefined ? 0 : previousAttempts) + 1;
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
      if (pendingFor !== null && tool.name === pendingFor) {
        return new Promise(resolve => {
          pendingResolvers.set(tool.name, () => {
            install(tool, registerOptions);
            resolve();
          });
        });
      }
      install(tool, registerOptions);
      return undefined;
    },
    resolveRegistration(name) {
      const resolver = pendingResolvers.get(name);
      if (resolver === undefined) {
        throw new Error('No pending registration for ' + name);
      }
      pendingResolvers.delete(name);
      resolver();
    },
    async executeTool(name, input, client) {
      const tool = tools.get(name);
      if (tool === undefined) {
        throw new Error('No tool named ' + name);
      }
      return tool.execute(
        input,
        client !== undefined ? client : {signal: null},
      );
    },
    names() {
      return Array.from(tools.keys()).sort();
    },
    attempts(name) {
      const count = attemptCounts.get(name);
      return count === undefined ? 0 : count;
    },
    registrations() {
      return log.filter(entry => entry[0] === 'register').map(e => e[1]);
    },
  };
}

module.exports = {createFakeModelContext};
