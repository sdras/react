/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import {getModelContext} from './ReactDOMWebMCPModelContext';

// Whether `document.modelContext` exists, as an external store so the hook
// knows at render time (and on the server, where the answer is no). A browser
// extension can inject the API after the page has rendered, so while anyone
// is subscribed and the API is missing, one shared bounded poll looks for it.

const POLL_INTERVAL_MS = 500;
const MAX_POLLS = 20;

const listeners: Set<() => void> = new Set();
let timer: null | IntervalID = null;

function isSupported(): boolean {
  return getModelContext() !== null;
}

function stopPolling(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

function startPolling(): void {
  if (timer !== null) {
    return;
  }
  let polls = 0;
  timer = setInterval(() => {
    polls++;
    if (isSupported()) {
      stopPolling();
      const current = Array.from(listeners);
      for (let i = 0; i < current.length; i++) {
        current[i]();
      }
    } else if (polls >= MAX_POLLS) {
      stopPolling();
    }
  }, POLL_INTERVAL_MS);
}

export function subscribeToModelContext(listener: () => void): () => void {
  listeners.add(listener);
  if (!isSupported()) {
    startPolling();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stopPolling();
    }
  };
}

export function getModelContextSnapshot(): boolean {
  return isSupported();
}

export function getModelContextServerSnapshot(): boolean {
  return false;
}
