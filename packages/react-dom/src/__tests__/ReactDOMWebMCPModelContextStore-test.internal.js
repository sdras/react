/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails react-core
 */

'use strict';

let Store;

const POLL_INTERVAL_MS = 500;
const MAX_POLLS = 20;

function installModelContext() {
  document.modelContext = {registerTool() {}};
}

describe('ReactDOM WebMCP model context store', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllTimers();
    delete document.modelContext;
    Store = require('react-dom/src/shared/webmcp/ReactDOMWebMCPModelContextStore');
  });

  afterEach(() => {
    delete document.modelContext;
  });

  it('reports whether document.modelContext can register tools', () => {
    expect(Store.getModelContextSnapshot()).toBe(false);
    expect(Store.getModelContextServerSnapshot()).toBe(false);
    document.modelContext = {};
    expect(Store.getModelContextSnapshot()).toBe(false);
    installModelContext();
    expect(Store.getModelContextSnapshot()).toBe(true);
    // The server never has it, whatever the document says.
    expect(Store.getModelContextServerSnapshot()).toBe(false);
  });

  it('does not poll while the API is there', () => {
    installModelContext();
    const unsubscribe = Store.subscribeToModelContext(() => {});
    expect(jest.getTimerCount()).toBe(0);
    unsubscribe();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('shares one poll between subscribers and notifies each once the API appears', () => {
    const first = jest.fn();
    const second = jest.fn();
    const unsubscribeFirst = Store.subscribeToModelContext(first);
    expect(jest.getTimerCount()).toBe(1);
    const unsubscribeSecond = Store.subscribeToModelContext(second);
    expect(jest.getTimerCount()).toBe(1);

    jest.advanceTimersByTime(POLL_INTERVAL_MS * 3);
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();

    installModelContext();
    jest.advanceTimersByTime(POLL_INTERVAL_MS);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    // Found: the poll is over.
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(POLL_INTERVAL_MS * MAX_POLLS);
    expect(first).toHaveBeenCalledTimes(1);

    unsubscribeFirst();
    unsubscribeSecond();
  });

  it('stops polling when the last subscriber leaves', () => {
    const unsubscribeFirst = Store.subscribeToModelContext(() => {});
    const unsubscribeSecond = Store.subscribeToModelContext(() => {});
    expect(jest.getTimerCount()).toBe(1);
    unsubscribeFirst();
    expect(jest.getTimerCount()).toBe(1);
    unsubscribeSecond();
    expect(jest.getTimerCount()).toBe(0);
    // Nothing is notified after that, even once the API shows up.
    const late = jest.fn();
    const unsubscribeLate = Store.subscribeToModelContext(late);
    unsubscribeLate();
    installModelContext();
    jest.advanceTimersByTime(POLL_INTERVAL_MS * 2);
    expect(late).not.toHaveBeenCalled();
  });

  it('gives up after the last poll and starts over for a new subscriber', () => {
    const listener = jest.fn();
    const unsubscribe = Store.subscribeToModelContext(listener);
    jest.advanceTimersByTime(POLL_INTERVAL_MS * (MAX_POLLS - 1));
    expect(jest.getTimerCount()).toBe(1);
    jest.advanceTimersByTime(POLL_INTERVAL_MS);
    expect(jest.getTimerCount()).toBe(0);

    // An API injected after the window is not noticed by the old poll...
    installModelContext();
    jest.advanceTimersByTime(POLL_INTERVAL_MS * MAX_POLLS);
    expect(listener).not.toHaveBeenCalled();
    // ...but a fresh read tells the truth, and the subscription is still
    // registered, so a later notification would reach it.
    expect(Store.getModelContextSnapshot()).toBe(true);
    unsubscribe();

    // A new subscriber while the API is missing starts a new poll.
    delete document.modelContext;
    const later = jest.fn();
    const unsubscribeLater = Store.subscribeToModelContext(later);
    expect(jest.getTimerCount()).toBe(1);
    installModelContext();
    jest.advanceTimersByTime(POLL_INTERVAL_MS);
    expect(later).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
    unsubscribeLater();
  });

  it('lets a listener unsubscribe while being notified', () => {
    const calls = [];
    const unsubscribeFirst = Store.subscribeToModelContext(() => {
      calls.push('first');
      unsubscribeSecond();
    });
    const unsubscribeSecond = Store.subscribeToModelContext(() => {
      calls.push('second');
    });
    installModelContext();
    jest.advanceTimersByTime(POLL_INTERVAL_MS);
    // The snapshot of listeners taken before notifying still includes the
    // second one; removing it mid-iteration must not throw or skip anyone.
    expect(calls).toEqual(['first', 'second']);
    unsubscribeFirst();
    expect(jest.getTimerCount()).toBe(0);
  });
});
