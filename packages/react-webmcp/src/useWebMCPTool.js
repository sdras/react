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
  ToolAnnotations,
  ToolExecute,
  ToolStatus,
} from './ReactWebMCPTypes';

import * as React from 'react';
import {useWebMCP} from 'use-webmcp-tool';

import {resolveAnnotations} from './ReactWebMCPAnnotations';
import {
  computeSignature,
  resolveQualifiedName,
  safeStringify,
} from './ReactWebMCPNames';
import {removeToolRecord, upsertToolRecord} from './ReactWebMCPRegistry';
import {ToolScopeContext} from './ReactWebMCPToolScope';
import {reportIssues, validateExecute} from './ReactWebMCPValidation';

export type UseWebMCPToolOptions = {
  // Local tool name; the enclosing ToolScope names are prefixed to it.
  name: string,
  description: string,
  inputSchema?: mixed,
  // Receives the agent's input and {signal}; the signal aborts on unmount.
  execute: ToolExecute,
  // Stable identity in the registry. Defaults to the qualified name.
  key?: string,
  // Drives the WebMCP annotation hints. Agents assume mutation by default.
  safety?: Safety,
  lifetime?: Lifetime,
  // Explicit hints, merged over the ones derived from `safety`.
  annotations?: ToolAnnotations,
  // Register only while true. Combined with the ToolScope availability.
  enabled?: boolean,
  formatOutput?: (result: mixed, input: mixed) => mixed,
  onError?: (error: mixed) => void,
};

export type UseWebMCPToolResult = {
  // `document.modelContext` exists in this environment.
  supported: boolean,
  // The tool is currently registered with the browser.
  registered: boolean,
  error: Error | null,
  // The name the agent sees, including scope prefixes.
  qualifiedName: string,
  // Whether the tool is meant to be exposed right now.
  available: boolean,
};

const {useContext, useDebugValue, useEffect, useMemo, useRef} = React;

// Wraps `useWebMCP` from `use-webmcp-tool` (which owns registration, the
// stale-closure fix, and result normalization) with what a React tree needs
// on top: scoped names, safety-derived annotations, availability, and a
// mirror of the tool into the react-webmcp registry for developer tooling.
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

  const scope = useContext(ToolScopeContext);
  const scopePath = scope.path;
  const qualifiedName = resolveQualifiedName(scopePath, name);

  // Inline annotation objects change identity every render; compare content.
  const annotationsKey = safeStringify(annotations);
  const resolvedAnnotations = useMemo(
    () => resolveAnnotations(resolvedSafety, annotations),
    [resolvedSafety, annotationsKey],
  );

  // The ref object itself is the owner token: React stores it as this hook's
  // state, so developer tooling can find the owning component by walking the
  // fiber's hook list and comparing identity.
  const ownerToken = useRef(null);

  // Gives `execute` an AbortSignal that fires when the component unmounts.
  const controllerRef = useRef<AbortController | null>(null);
  useEffect(() => {
    if (
      controllerRef.current === null ||
      controllerRef.current.signal.aborted
    ) {
      controllerRef.current = new AbortController();
    }
    const controller = controllerRef.current;
    return () => {
      controller.abort();
    };
  }, []);

  // Note: a hook-registered tool stays registered while a Suspense boundary
  // hides its component. React keeps the hidden tree mounted and does not run
  // its effects until it is shown again, so nothing here can react to the
  // fallback. Gate with `enabled` or <ToolScope available>, or use <ToolTree>,
  // whose host instances are told about Suspense directly.
  const effectiveEnabled = isEnabled && scope.available;

  const wrappedExecute = (input: any) => {
    const controller = controllerRef.current;
    return execute(input, {
      signal: controller === null ? null : controller.signal,
    });
  };

  const hookState = useWebMCP({
    name: qualifiedName,
    description,
    inputSchema,
    annotations: resolvedAnnotations,
    execute: wrappedExecute,
    enabled: effectiveEnabled,
    formatOutput,
    onError,
  });

  const recordKey = key != null ? key : qualifiedName;
  const hasExecute = typeof execute === 'function';

  let status: ToolStatus;
  let errorMessage: string | null = null;
  if (!hasExecute) {
    status = 'error';
    errorMessage = 'The tool has no execute function.';
  } else if (hookState.error !== null) {
    status = 'error';
    errorMessage = hookState.error.message;
  } else if (!hookState.supported) {
    status = 'unsupported';
  } else if (!isEnabled) {
    status = 'disabled';
  } else if (!scope.available) {
    status = 'unavailable';
  } else if (hookState.registered) {
    status = 'registered';
  } else {
    // Registration is pending until the hook's effect has run.
    status = 'unavailable';
  }

  const signature = computeSignature(
    qualifiedName,
    description,
    inputSchema,
    resolvedAnnotations,
  );
  const supported = hookState.supported;
  const scopeAvailable = scope.available;

  useEffect(() => {
    if (__DEV__) {
      const issue = validateExecute(qualifiedName, execute);
      if (issue !== null) {
        reportIssues(recordKey, [issue]);
      }
    }
    upsertToolRecord({
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
    });
    return () => {
      removeToolRecord(recordKey);
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
    supported: hookState.supported,
    registered: hookState.registered,
    error: hookState.error,
    qualifiedName,
    available: effectiveEnabled,
  };
}
