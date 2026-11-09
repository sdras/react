/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {
  Lifetime,
  Safety,
  ToolExecute,
  ToolExecuteClient,
  ToolRecord,
  ToolResponse,
  ToolStatus,
  UseWebMCPToolOptions,
  UseWebMCPToolResult,
  WebMCPToolDescriptor,
} from 'shared/ReactWebMCPTypes';

import * as React from 'react';

import reportGlobalError from 'shared/reportGlobalError';

import {resolveAnnotations} from './ReactDOMWebMCPAnnotations';
import {getModelContext} from './ReactDOMWebMCPModelContext';
import {
  getModelContextServerSnapshot,
  getModelContextSnapshot,
  subscribeToModelContext,
} from './ReactDOMWebMCPModelContextStore';
import {
  contentKey,
  resolveQualifiedName,
  safeStringify,
  signatureFromKeys,
} from './ReactDOMWebMCPNames';
import {
  normalizeToolError,
  normalizeToolResult,
} from './ReactDOMWebMCPNormalize';
import {
  checkToolRecordCollisions,
  removeToolRecord,
  upsertToolRecord,
} from './ReactDOMWebMCPRegistry';
import {combineAbortSignals} from './ReactDOMWebMCPSignal';
import {getToolScopeContext} from './ReactDOMWebMCPToolScope';
import {reportIssues, validateExecute} from './ReactDOMWebMCPValidation';

const {
  useContext,
  useDebugValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} = React;

// The hook's committed values. One object per component, created by the
// mirroring layout effect on the first commit and assigned on every later one.
type Latest = {
  execute: ToolExecute,
  formatOutput: ?(result: mixed, input: mixed) => mixed,
  onError: ?(error: mixed) => void,
  // The record for developer tooling, as of the last commit.
  record: ToolRecord,
};

type Failure = {
  // The tool definition that failed. A different definition is tried again.
  signature: string,
  error: Error,
};

function toError(error: mixed): Error {
  if (error instanceof Error) {
    return error;
  }
  // eslint-disable-next-line react-internal/prod-error-codes
  return new Error(safeStringify(error));
}

// A tool without `execute` is never handed to the browser. This is the error
// its registry record carries and the result a stray call would get; the DEV
// warning for it lives in ReactDOMWebMCPValidation.
function missingExecuteMessage(qualifiedName: string): string {
  return 'The WebMCP tool "' + qualifiedName + '" has no `execute` function.';
}

// The function handed to the browser. It reads `execute`, `formatOutput` and
// `onError` from the committed values when the agent calls it, so the latest
// render's closures run without re-registering the tool. It never rejects:
// every failure becomes an `isError` result.
function runTool(
  latest: Latest,
  qualifiedName: string,
  input: mixed,
  client: ?ToolExecuteClient,
  lifetimeSignal: null | AbortSignal,
): Promise<ToolResponse> {
  return new Promise(resolve => {
    const fail = (error: mixed) => {
      const onError = latest.onError;
      if (typeof onError === 'function') {
        try {
          onError(error);
        } catch (x) {
          // The agent still receives the original failure. The handler's own
          // error surfaces as an uncaught error, as one thrown from an event
          // handler does.
          reportGlobalError(x);
        }
      }
      resolve(normalizeToolError(error));
    };
    const execute = latest.execute;
    if (typeof execute !== 'function') {
      resolve(normalizeToolError(missingExecuteMessage(qualifiedName)));
      return;
    }
    let result;
    try {
      result = execute(input, {
        signal: combineAbortSignals(
          client != null && client.signal != null ? client.signal : null,
          lifetimeSignal,
        ),
      });
    } catch (error) {
      fail(error);
      return;
    }
    Promise.resolve(result).then(value => {
      try {
        const format = latest.formatOutput;
        const shaped =
          typeof format === 'function' ? format(value, input) : value;
        if (shaped instanceof Error) {
          throw shaped;
        }
        resolve(normalizeToolResult(shaped));
      } catch (error) {
        fail(error);
      }
    }, fail);
  });
}

// What DevTools shows for the hook: the last committed record. The formatter
// runs only while a component is inspected.
function formatDebugValue(latest: {current: null | Latest}): mixed {
  const current = latest.current;
  if (current === null) {
    return null;
  }
  const record = current.record;
  return {
    name: record.qualifiedName,
    status: record.status,
    safety: record.safety,
    source: record.source,
  };
}

// Registers a WebMCP tool with the browser for as long as the calling
// component is mounted, enabled, inside available scopes, and visible.
//
// Registration happens in a layout effect, so the tool disappears from the
// agent whenever React disconnects the component's layout effects: a Suspense
// boundary showing its fallback, or an Activity boundary hiding it. The
// registry record for developer tooling is kept in a passive effect, so it
// stays listed, marked unavailable and hidden, for exactly as long as React
// keeps the passive effects connected. Today that is the case under a Suspense
// fallback (the reconciler keeps them connected there for backwards
// compatibility) and not under a hidden Activity, where the record is removed
// together with the registration and written again on reveal.
export function useWebMCPTool(
  options: UseWebMCPToolOptions,
): UseWebMCPToolResult {
  const {
    name,
    description,
    inputSchema,
    execute,
    key,
    safety,
    lifetime,
    annotations,
    enabled,
    formatOutput,
    onError,
  } = options;
  const resolvedSafety: null | Safety = safety == null ? null : safety;
  const resolvedLifetime: Lifetime = lifetime == null ? 'view' : lifetime;
  const isEnabled = enabled !== false;
  const hasExecute = typeof execute === 'function';

  const supported = useSyncExternalStore(
    subscribeToModelContext,
    getModelContextSnapshot,
    getModelContextServerSnapshot,
  );

  const scope = useContext(getToolScopeContext());
  const scopePath = scope.path;
  const scopeAvailable = scope.available;
  const qualifiedName = resolveQualifiedName(scopePath, name);
  const recordKey = key != null ? key : qualifiedName;

  // Inline `inputSchema` and `annotations` objects get a new identity every
  // render, so the signature compares them by content. They are serialized
  // again only when the identity changed: an author who memoizes them pays
  // nothing per render.
  const inputSchemaKey = useMemo(() => contentKey(inputSchema), [inputSchema]);
  const resolved = useMemo(() => {
    const value = resolveAnnotations(resolvedSafety, annotations);
    return {annotations: value, key: contentKey(value)};
  }, [resolvedSafety, annotations]);
  const resolvedAnnotations = resolved.annotations;
  const signature = signatureFromKeys(
    qualifiedName,
    description,
    inputSchemaKey,
    resolved.key,
  );

  // The ref object itself is the owner token: React stores it as this hook's
  // state, so developer tooling can find the owning component by walking the
  // fiber's hook list and comparing identity.
  const ownerToken = useRef(null);

  const [failure, setFailure] = useState<null | Failure>(null);
  const error =
    failure !== null && failure.signature === signature ? failure.error : null;

  // The signature of the definition the browser last accepted from this hook.
  // Written only by the registering layout effect below, once the browser has
  // accepted, so a definition reports as registered from the re-render that
  // follows its acceptance and never while it is being tried for the first
  // time or after a refusal. It is not cleared on teardown: clearing it from
  // the layout cleanup would schedule an update inside every tree a Suspense
  // boundary hides, and React would retry rendering that tree at once.
  const [accepted, setAccepted] = useState<null | string>(null);

  const available = isEnabled && scopeAvailable;
  const shouldRegister = supported && hasExecute && available && error === null;
  const registered = shouldRegister && accepted === signature;

  let status: ToolStatus;
  let errorMessage: null | string = null;
  if (!hasExecute) {
    status = 'error';
    errorMessage = missingExecuteMessage(qualifiedName);
  } else if (error !== null) {
    status = 'error';
    errorMessage = error.message;
  } else if (!supported) {
    status = 'unsupported';
  } else if (!isEnabled) {
    status = 'disabled';
  } else if (!scopeAvailable) {
    status = 'unavailable';
  } else {
    status = 'registered';
  }

  // Everything the effects below and the function handed to the browser read
  // from a render goes through one object, written by this layout effect and
  // never during render. They only ever see committed values: a render React
  // discards (an interrupted transition) must not leak into the registry. The
  // object is created on the first commit and assigned afterwards; the record
  // is built here, so render allocates none of it.
  const latest = useRef<null | Latest>(null);
  useLayoutEffect(() => {
    const record: ToolRecord = {
      key: recordKey,
      qualifiedName,
      name,
      scopePath,
      description,
      inputSchema,
      annotations: resolvedAnnotations,
      safety: resolvedSafety,
      lifetime: resolvedLifetime,
      source: 'hook',
      status,
      availability: {
        enabled: isEnabled,
        scopeAvailable,
        hidden: false,
        supported,
      },
      error: errorMessage,
      ownerToken,
    };
    const current = latest.current;
    if (current === null) {
      latest.current = {execute, formatOutput, onError, record};
    } else {
      current.execute = execute;
      current.formatOutput = formatOutput;
      current.onError = onError;
      current.record = record;
    }
  });

  // An AbortSignal for `execute` that fires when the tool goes away: unmount,
  // or a Suspense or Activity boundary hiding the component.
  const lifetimeControllerRef = useRef<null | AbortController>(null);
  useLayoutEffect(() => {
    const controller = new AbortController();
    lifetimeControllerRef.current = controller;
    return () => {
      controller.abort();
    };
  }, []);

  useLayoutEffect(() => {
    // Written by the mirroring layout effect above, which runs first in every
    // commit. Its fields are assigned in place, so reading them from `current`
    // later always gives the latest committed values.
    const current = latest.current;
    if (!shouldRegister || current === null) {
      return undefined;
    }
    const modelContext = getModelContext();
    if (modelContext === null) {
      return undefined;
    }
    const controller = new AbortController();
    const descriptor: WebMCPToolDescriptor = {
      name: qualifiedName,
      description,
      inputSchema,
      annotations: resolvedAnnotations,
      execute: (input: mixed, client: ?ToolExecuteClient) => {
        const lifetimeController = lifetimeControllerRef.current;
        return runTool(
          current,
          qualifiedName,
          input,
          client,
          lifetimeController === null ? null : lifetimeController.signal,
        );
      },
    };
    const failed = (thrown: mixed) => {
      if (controller.signal.aborted) {
        // Superseded by a newer registration or an unmount.
        return;
      }
      controller.abort();
      setFailure({signature, error: toError(thrown)});
    };
    const succeeded = () => {
      if (controller.signal.aborted) {
        // Superseded by a newer registration or an unmount.
        return;
      }
      setAccepted(signature);
    };
    try {
      const result = modelContext.registerTool(descriptor, {
        signal: controller.signal,
      });
      // A polyfill may return something other than a promise.
      // $FlowFixMe[method-unbinding]
      if (result != null && typeof result.then === 'function') {
        // A browser that answers asynchronously holds the tool once it
        // resolves, not before.
        result.then(succeeded, failed);
      } else {
        succeeded();
      }
    } catch (thrown) {
      failed(thrown);
      return undefined;
    }
    upsertToolRecord(current.record);
    return () => {
      // Aborting the signal is how a WebMCP tool is unregistered. The record
      // stays, marked hidden, until the passive cleanup below removes it: in
      // this same commit under a hidden Activity, on unmount under a Suspense
      // fallback. A registration that comes back writes it again.
      controller.abort();
      const record = current.record;
      upsertToolRecord({
        ...record,
        status: 'unavailable',
        availability: {...record.availability, hidden: true},
      });
    };
  }, [shouldRegister, signature]);

  useEffect(() => {
    if (__DEV__) {
      const issue = validateExecute(qualifiedName, execute);
      if (issue !== null) {
        reportIssues(recordKey, [issue]);
      }
    }
    // Written by the mirroring layout effect of this same commit.
    const current = latest.current;
    if (current !== null) {
      upsertToolRecord(current.record);
    }
    if (__DEV__) {
      // After every cleanup of this commit, so a component this one replaced
      // is gone by now and anything else holding the key is a real collision.
      checkToolRecordCollisions(ownerToken);
    }
    // `signature` stands in for name/description/inputSchema/annotations.
  }, [
    recordKey,
    signature,
    status,
    errorMessage,
    scopePath,
    resolvedSafety,
    resolvedLifetime,
    isEnabled,
    scopeAvailable,
    supported,
  ]);

  // The record leaves the registry when this passive effect is cleaned up: on
  // unmount, and when an Activity boundary hides the component. A change above
  // rewrites it in place, so the tool keeps its position in the list and is
  // never missing from a snapshot between its old and new record. A Suspense
  // fallback keeps it: React disconnects layout effects then, not passive ones.
  useEffect(() => {
    return () => {
      removeToolRecord(ownerToken);
    };
  }, []);

  useDebugValue(latest, formatDebugValue);

  return {
    supported,
    registered,
    error,
    qualifiedName,
    available,
  };
}
