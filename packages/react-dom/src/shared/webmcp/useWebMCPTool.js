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
  ToolRecord,
  ToolResponse,
  ToolStatus,
  UseWebMCPToolOptions,
  UseWebMCPToolResult,
  WebMCPToolDescriptor,
} from 'shared/ReactWebMCPTypes';

import * as React from 'react';

import {resolveAnnotations} from './ReactDOMWebMCPAnnotations';
import {getModelContext} from './ReactDOMWebMCPModelContext';
import {
  getModelContextServerSnapshot,
  getModelContextSnapshot,
  subscribeToModelContext,
} from './ReactDOMWebMCPModelContextStore';
import {
  computeSignature,
  contentKey,
  resolveQualifiedName,
  safeStringify,
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

type Latest = {
  execute: mixed,
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

// The function handed to the browser. It reads `execute`, `formatOutput` and
// `onError` through a ref when the agent calls it, so the latest render's
// closures run without re-registering the tool. It never rejects: every
// failure becomes an `isError` result.
function runTool(
  latest: {current: Latest},
  qualifiedName: string,
  input: any,
  client: any,
  lifetimeSignal: AbortSignal | null,
): Promise<ToolResponse> {
  return new Promise(resolve => {
    const fail = (error: mixed) => {
      const onError = latest.current.onError;
      if (typeof onError === 'function') {
        try {
          onError(error);
        } catch (x) {
          // A failing error handler must not mask the original failure.
        }
      }
      resolve(normalizeToolError(error));
    };
    const execute: any = latest.current.execute;
    if (typeof execute !== 'function') {
      resolve(
        normalizeToolError(
          'The tool "' + qualifiedName + '" has no execute function.',
        ),
      );
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
        const format = latest.current.formatOutput;
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

// Registers a WebMCP tool with the browser for as long as the calling
// component is mounted, enabled, inside available scopes, and visible.
//
// Registration happens in a layout effect. React disconnects layout effects
// while a Suspense boundary shows its fallback and reconnects them on reveal,
// so a tool disappears from the agent together with the UI it acts on. The
// registry record is kept in a passive effect, which survives the hide, so
// developer tooling still sees the tool, marked unavailable and hidden.
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
  const resolvedSafety: Safety | null = safety == null ? null : safety;
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

  // Inline annotation objects change identity every render; compare content.
  const annotationsKey = contentKey(annotations);
  const resolvedAnnotations = useMemo(
    () => resolveAnnotations(resolvedSafety, annotations),
    [resolvedSafety, annotationsKey],
  );
  const signature = computeSignature(
    qualifiedName,
    description,
    inputSchema,
    resolvedAnnotations,
  );

  // The ref object itself is the owner token: React stores it as this hook's
  // state, so developer tooling can find the owning component by walking the
  // fiber's hook list and comparing identity.
  const ownerToken = useRef(null);

  const [failure, setFailure] = useState<Failure | null>(null);
  const error =
    failure !== null && failure.signature === signature ? failure.error : null;

  const available = isEnabled && scopeAvailable;
  const shouldRegister = supported && hasExecute && available && error === null;

  let status: ToolStatus;
  let errorMessage: string | null = null;
  if (!hasExecute) {
    status = 'error';
    errorMessage = 'The tool has no execute function.';
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

  // Everything the effects below read from this render goes through one ref,
  // mirrored by a layout effect and never during render. The effects then
  // only ever see a committed record: a render React discards (an interrupted
  // transition) must not leak into the registry. The handlers are read the
  // same way when the agent calls the tool.
  const latest = useRef<Latest>({execute, formatOutput, onError, record});
  useLayoutEffect(() => {
    latest.current = {execute, formatOutput, onError, record};
  });

  // An AbortSignal for `execute` that fires when the tool goes away: unmount,
  // or a Suspense boundary hiding the component.
  const lifetimeControllerRef = useRef<AbortController | null>(null);
  useLayoutEffect(() => {
    const controller = new AbortController();
    lifetimeControllerRef.current = controller;
    return () => {
      controller.abort();
    };
  }, []);

  useLayoutEffect(() => {
    if (!shouldRegister) {
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
      execute: (input: any, client: any) => {
        const lifetimeController = lifetimeControllerRef.current;
        return runTool(
          latest,
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
    try {
      const result: any = modelContext.registerTool(descriptor, {
        signal: controller.signal,
      });
      if (result != null && typeof result.then === 'function') {
        result.then(undefined, failed);
      }
    } catch (thrown) {
      failed(thrown);
      return undefined;
    }
    upsertToolRecord(latest.current.record);
    return () => {
      // Aborting the signal is how a WebMCP tool is unregistered. The record
      // stays, marked hidden, until the passive cleanup removes it on a real
      // unmount; after a Suspense hide it is restored by the next create.
      controller.abort();
      const current = latest.current.record;
      upsertToolRecord({
        ...current,
        status: 'unavailable',
        availability: {...current.availability, hidden: true},
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
    upsertToolRecord(latest.current.record);
    if (__DEV__) {
      // After every cleanup of this commit, so a component this one replaced
      // is gone by now and anything else holding the key is a real collision.
      checkToolRecordCollisions(ownerToken);
    }
    return () => {
      removeToolRecord(ownerToken);
    };
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

  useDebugValue({
    name: qualifiedName,
    status,
    safety: resolvedSafety,
    source: 'hook',
  });

  return {
    supported,
    registered: shouldRegister,
    error,
    qualifiedName,
    available,
  };
}
