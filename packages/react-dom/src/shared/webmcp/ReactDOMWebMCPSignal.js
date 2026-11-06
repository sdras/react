/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

// The signal `execute` receives: aborted when the browser cancels the call
// (its client signal) or when the tool goes away (unmount, a Suspense boundary
// hiding it, leaving the tool tree), whichever comes first. The lifetime
// signal is never dropped just because the browser supplied one.
export function combineAbortSignals(
  client: AbortSignal | null,
  lifetime: AbortSignal | null,
): AbortSignal | null {
  if (client === null) {
    return lifetime;
  }
  if (lifetime === null || client.aborted) {
    return client;
  }
  if (lifetime.aborted) {
    return lifetime;
  }
  const AbortSignalAny = (AbortSignal as any).any;
  if (typeof AbortSignalAny === 'function') {
    return AbortSignalAny([client, lifetime]);
  }
  const controller: any = new AbortController();
  const onAbort = function (this: AbortSignal) {
    client.removeEventListener('abort', onAbort);
    lifetime.removeEventListener('abort', onAbort);
    controller.abort((this as any).reason);
  };
  client.addEventListener('abort', onAbort);
  lifetime.addEventListener('abort', onAbort);
  return controller.signal;
}
