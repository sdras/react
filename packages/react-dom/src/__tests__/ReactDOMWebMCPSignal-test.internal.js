/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails react-core
 */

'use strict';

let combineAbortSignals;

describe('ReactDOM WebMCP combineAbortSignals', () => {
  beforeEach(() => {
    jest.resetModules();
    ({
      combineAbortSignals,
    } = require('react-dom/src/shared/webmcp/ReactDOMWebMCPSignal'));
  });

  it('returns the other side when one is missing', () => {
    const client = new AbortController().signal;
    const lifetime = new AbortController().signal;
    expect(combineAbortSignals(null, null)).toBe(null);
    expect(combineAbortSignals(client, null)).toBe(client);
    expect(combineAbortSignals(null, lifetime)).toBe(lifetime);
  });

  it('returns a side that is already aborted as it is', () => {
    const client = new AbortController();
    const lifetime = new AbortController();
    client.abort(new Error('cancelled before the call'));
    expect(combineAbortSignals(client.signal, lifetime.signal)).toBe(
      client.signal,
    );

    const laterClient = new AbortController();
    const goneLifetime = new AbortController();
    goneLifetime.abort('unmounted');
    expect(combineAbortSignals(laterClient.signal, goneLifetime.signal)).toBe(
      goneLifetime.signal,
    );
  });

  // The combined signal is built by AbortSignal.any where the browser has
  // it and by hand everywhere else. Both must behave the same.
  function itCombinesBothSides() {
    it('is live while both sides are live', () => {
      const client = new AbortController();
      const lifetime = new AbortController();
      const combined = combineAbortSignals(client.signal, lifetime.signal);
      expect(combined).not.toBe(client.signal);
      expect(combined).not.toBe(lifetime.signal);
      expect(combined.aborted).toBe(false);
    });

    it('aborts with the reason when the browser cancels the call', () => {
      const client = new AbortController();
      const lifetime = new AbortController();
      const combined = combineAbortSignals(client.signal, lifetime.signal);
      const seen = [];
      combined.addEventListener('abort', () => seen.push(combined.reason));
      const reason = new Error('user cancelled');
      client.abort(reason);
      expect(combined.aborted).toBe(true);
      expect(combined.reason).toBe(reason);
      expect(seen).toEqual([reason]);
      expect(lifetime.signal.aborted).toBe(false);
    });

    it('aborts with the reason when the tool goes away', () => {
      const client = new AbortController();
      const lifetime = new AbortController();
      const combined = combineAbortSignals(client.signal, lifetime.signal);
      lifetime.abort('unmounted');
      expect(combined.aborted).toBe(true);
      expect(combined.reason).toBe('unmounted');
      expect(client.signal.aborted).toBe(false);
    });

    it('keeps the first reason when the other side aborts later', () => {
      const client = new AbortController();
      const lifetime = new AbortController();
      const combined = combineAbortSignals(client.signal, lifetime.signal);
      let events = 0;
      combined.addEventListener('abort', () => {
        events++;
      });
      lifetime.abort('first');
      client.abort('second');
      expect(combined.reason).toBe('first');
      expect(events).toBe(1);
    });

    it('combines each call separately', () => {
      const client = new AbortController();
      const lifetime = new AbortController();
      const first = combineAbortSignals(client.signal, lifetime.signal);
      const second = combineAbortSignals(
        new AbortController().signal,
        lifetime.signal,
      );
      client.abort();
      expect(first.aborted).toBe(true);
      expect(second.aborted).toBe(false);
      lifetime.abort();
      expect(second.aborted).toBe(true);
    });
  }

  describe('with AbortSignal.any', () => {
    beforeEach(() => {
      expect(typeof AbortSignal.any).toBe('function');
    });
    itCombinesBothSides();
  });

  describe('without AbortSignal.any', () => {
    let original;
    beforeEach(() => {
      original = AbortSignal.any;
      AbortSignal.any = undefined;
    });
    afterEach(() => {
      AbortSignal.any = original;
    });
    itCombinesBothSides();
  });
});
