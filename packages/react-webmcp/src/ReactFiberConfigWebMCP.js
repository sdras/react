/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {ReactContext} from 'shared/ReactTypes';
import type {EventPriority} from 'react-reconciler/src/ReactEventPriorities';
import type {
  Lifetime,
  ModelContextLike,
  Safety,
  ToolAnnotations,
  ToolResponse,
  ToolStatus,
  WebMCPToolDescriptor,
} from './ReactWebMCPTypes';

import {REACT_CONTEXT_TYPE} from 'shared/ReactSymbols';
import {
  DefaultEventPriority,
  NoEventPriority,
} from 'react-reconciler/src/ReactEventPriorities';

import {resolveAnnotations} from './ReactWebMCPAnnotations';
import {getModelContext} from './ReactWebMCPModelContext';
import {
  computeSignature,
  resolveQualifiedName,
  safeStringify,
} from './ReactWebMCPNames';
import {normalizeToolError, normalizeToolResult} from './ReactWebMCPNormalize';
import {
  batchToolRecordUpdates,
  getToolRecord,
  removeToolRecord,
  upsertToolRecord,
} from './ReactWebMCPRegistry';

export {default as rendererVersion} from 'shared/ReactVersion';
export const rendererPackageName = 'react-webmcp';
export const extraDevToolsConfig = null;

export * from 'react-reconciler/src/ReactFiberConfigWithNoPersistence';
export * from 'react-reconciler/src/ReactFiberConfigWithNoHydration';
export * from 'react-reconciler/src/ReactFiberConfigWithNoScopes';
export * from 'react-reconciler/src/ReactFiberConfigWithNoTestSelectors';
export * from 'react-reconciler/src/ReactFiberConfigWithNoMicrotasks';
export * from 'react-reconciler/src/ReactFiberConfigWithNoResources';
export * from 'react-reconciler/src/ReactFiberConfigWithNoSingletons';
export * from 'react-reconciler/src/ReactFiberConfigWithNoViewTransition';

// This renderer turns a React tree of <Tool> and <Scope> elements into WebMCP
// tool registrations on `document.modelContext`. Nothing is written to the
// browser during the mutation phase. Every structural or prop change only
// marks the container dirty; `resetAfterCommit` then walks the committed tree
// once and reconciles the set of registered tools in a single pass, so the
// agent never observes a half-updated tool list.

export type Type = 'tool' | 'scope';
export type Props = Object;

type Registration = {
  controller: AbortController,
  signature: string,
  qualifiedName: string,
};

export type ToolInstance = {
  tag: 'tool',
  props: Props,
  parent: ScopeInstance | null,
  container: Container,
  // Set by hideInstance/unhideInstance when a Suspense boundary toggles.
  hidden: boolean,
  registration: Registration | null,
  // Remembered so a failed registration is not retried on every commit.
  failedSignature: string | null,
  failedMessage: string | null,
  recordKey: string | null,
  warnedInvalid: boolean,
  fiber: Object,
};

export type ScopeInstance = {
  tag: 'scope',
  props: Props,
  parent: ScopeInstance | null,
  container: Container,
  hidden: boolean,
  children: Array<Instance>,
  fiber: Object,
};

export type Instance = ToolInstance | ScopeInstance;
// Never created: text is rejected in createTextInstance.
export type TextInstance = {tag: 'text', text: string};
export type HydratableInstance = Instance | TextInstance;
export type PublicInstance = Instance;
export type HostContext = Object;
export type UpdatePayload = Object;
export type ChildSet = void;
export type TimeoutHandle = TimeoutID;
export type NoTimeout = -1;
export type EventResponder = any;
export type RendererInspectionConfig = $ReadOnly<{}>;
export type TransitionStatus = mixed;
export type FormInstance = Instance;
export type FragmentInstanceType = null;
export type GestureTimeline = null;

export type Container = {
  tag: 'container',
  children: Array<Instance>,
  // Every tool instance that currently has a registry record.
  knownTools: Set<ToolInstance>,
  dirty: boolean,
  // Where registrations go. Defaults to `document.modelContext`; tests and
  // the fixture shim can point it elsewhere.
  getTarget: () => ModelContextLike | null,
};

export function createToolContainer(
  getTarget: ?() => ModelContextLike | null,
): Container {
  return {
    tag: 'container',
    children: [],
    knownTools: new Set(),
    dirty: false,
    getTarget: getTarget != null ? getTarget : getModelContext,
  };
}

const NO_CONTEXT: HostContext = {};
if (__DEV__) {
  Object.freeze(NO_CONTEXT);
}

// Only these props affect what the agent sees, so only they mark the
// container dirty. `execute`, `formatOutput` and `onError` are read from the
// instance at call time and never cause a re-registration.
const TOOL_VISIBLE_PROPS = [
  'name',
  'description',
  'inputSchema',
  'safety',
  'annotations',
  'enabled',
  'id',
  'lifetime',
];
const SCOPE_VISIBLE_PROPS = ['name', 'available', 'path'];

function didVisiblePropsChange(
  keys: Array<string>,
  oldProps: Props,
  newProps: Props,
): boolean {
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (oldProps[key] !== newProps[key]) {
      return true;
    }
  }
  return false;
}

/** Instance tree maintenance */

function detachChild(child: Instance): void {
  const siblings =
    child.parent !== null ? child.parent.children : child.container.children;
  const index = siblings.indexOf(child);
  if (index !== -1) {
    siblings.splice(index, 1);
  }
  child.parent = null;
}

function attachChild(
  parent: ScopeInstance | Container,
  child: Instance,
  beforeChild: Instance | null,
): void {
  detachChild(child);
  child.parent = parent.tag === 'scope' ? parent : null;
  const siblings = parent.children;
  if (beforeChild === null) {
    siblings.push(child);
  } else {
    const index = siblings.indexOf(beforeChild);
    if (index === -1) {
      siblings.push(child);
    } else {
      siblings.splice(index, 0, child);
    }
  }
  child.container.dirty = true;
}

function assertScope(parentInstance: Instance): ScopeInstance {
  if (parentInstance.tag !== 'scope') {
    throw new Error(
      'react-webmcp: A <Tool> cannot have children. Nest tools inside a ' +
        '<Scope> instead.',
    );
  }
  return parentInstance;
}

/** Commit: reconcile registrations with the committed tree */

type PendingRegistration = {
  tool: ToolInstance,
  qualifiedName: string,
  description: string,
  inputSchema: mixed,
  annotations: ToolAnnotations,
  signature: string,
};

function abortRegistration(tool: ToolInstance): void {
  const registration = tool.registration;
  if (registration !== null) {
    tool.registration = null;
    registration.controller.abort();
  }
}

function handleExecuteError(tool: ToolInstance, error: mixed): ToolResponse {
  const onError = tool.props.onError;
  if (typeof onError === 'function') {
    try {
      onError(error);
    } catch (x) {
      // A failing error handler must not mask the original failure.
    }
  }
  return normalizeToolError(error);
}

// The function handed to the browser. It reads `execute` from the instance
// when the agent calls it, so the latest props (and the state they close
// over) are always used without re-registering.
function createExecute(
  tool: ToolInstance,
  qualifiedName: string,
): (input: any, client: any) => Promise<ToolResponse> {
  return function execute(input: any, client: any): Promise<ToolResponse> {
    return new Promise(resolve => {
      let result;
      try {
        const fn = tool.props.execute;
        if (typeof fn !== 'function') {
          throw new Error(
            'The tool "' + qualifiedName + '" has no execute function.',
          );
        }
        result = fn(input, {
          signal:
            client != null && client.signal != null ? client.signal : null,
        });
      } catch (error) {
        resolve(handleExecuteError(tool, error));
        return;
      }
      Promise.resolve(result).then(
        value => {
          try {
            const format = tool.props.formatOutput;
            const shaped =
              typeof format === 'function' ? format(value, input) : value;
            if (shaped instanceof Error) {
              throw shaped;
            }
            resolve(normalizeToolResult(shaped));
          } catch (error) {
            resolve(handleExecuteError(tool, error));
          }
        },
        error => {
          resolve(handleExecuteError(tool, error));
        },
      );
    });
  };
}

function onRegistrationFailed(
  tool: ToolInstance,
  registration: Registration,
  error: mixed,
): void {
  if (tool.registration !== registration) {
    // Superseded by a newer registration.
    return;
  }
  tool.registration = null;
  registration.controller.abort();
  const message = error instanceof Error ? error.message : safeStringify(error);
  tool.failedSignature = registration.signature;
  tool.failedMessage = message;
  if (tool.recordKey !== null) {
    const existing = getToolRecord(tool.recordKey);
    if (existing !== undefined) {
      upsertToolRecord({...existing, status: 'error', error: message});
    }
  }
}

function registerPending(
  target: ModelContextLike,
  pending: PendingRegistration,
): void {
  const tool = pending.tool;
  const controller = new AbortController();
  const registration: Registration = {
    controller,
    signature: pending.signature,
    qualifiedName: pending.qualifiedName,
  };
  tool.registration = registration;
  const descriptor: WebMCPToolDescriptor = {
    name: pending.qualifiedName,
    description: pending.description,
    inputSchema: pending.inputSchema,
    annotations: pending.annotations,
    execute: createExecute(tool, pending.qualifiedName),
  };
  try {
    const result: any = target.registerTool(descriptor, {
      signal: controller.signal,
    });
    if (result != null && typeof result.then === 'function') {
      result.then(undefined, (error: mixed) => {
        onRegistrationFailed(tool, registration, error);
      });
    }
  } catch (error) {
    onRegistrationFailed(tool, registration, error);
  }
}

function visitTool(
  tool: ToolInstance,
  path: $ReadOnlyArray<string>,
  scopeAvailable: boolean,
  hidden: boolean,
  target: ModelContextLike | null,
  toRegister: Array<PendingRegistration>,
): void {
  const props = tool.props;
  const name = typeof props.name === 'string' ? props.name : '';
  const description =
    typeof props.description === 'string' ? props.description : '';
  const qualifiedName = resolveQualifiedName(path, name);
  const enabled = props.enabled !== false;
  const safety: Safety | null = props.safety == null ? null : props.safety;
  const lifetime: Lifetime = props.lifetime == null ? 'view' : props.lifetime;
  const annotations = resolveAnnotations(safety, props.annotations);
  const inputSchema = props.inputSchema;

  const valid =
    name !== '' && description !== '' && typeof props.execute === 'function';
  let errorMessage: string | null = null;
  if (!valid) {
    errorMessage =
      'A <Tool> needs a name, a description, and an execute function. ' +
      'It was not registered.';
    if (__DEV__) {
      if (!tool.warnedInvalid) {
        tool.warnedInvalid = true;
        console.error(
          'react-webmcp: A <Tool> needs a name, a description, and an ' +
            'execute function. It was not registered. Received name=%s.',
          safeStringify(props.name),
        );
      }
    }
  }

  const supported = target !== null;
  const signature = computeSignature(
    qualifiedName,
    description,
    inputSchema,
    annotations,
  );
  if (tool.failedSignature !== null && tool.failedSignature !== signature) {
    // The definition changed since the failure; allow a retry.
    tool.failedSignature = null;
    tool.failedMessage = null;
  }
  const failed = tool.failedSignature !== null;
  const shouldRegister =
    supported && valid && !failed && enabled && scopeAvailable && !hidden;

  const registration = tool.registration;
  if (
    registration !== null &&
    (!shouldRegister || registration.signature !== signature)
  ) {
    abortRegistration(tool);
  }
  if (shouldRegister && tool.registration === null) {
    toRegister.push({
      tool,
      qualifiedName,
      description,
      inputSchema,
      annotations,
      signature,
    });
  }

  let status: ToolStatus;
  if (!valid) {
    status = 'error';
  } else if (failed) {
    status = 'error';
    errorMessage = tool.failedMessage;
  } else if (!supported) {
    status = 'unsupported';
  } else if (!enabled) {
    status = 'disabled';
  } else if (!scopeAvailable || hidden) {
    status = 'unavailable';
  } else {
    status = 'registered';
  }

  const recordKey =
    typeof props.id === 'string' && props.id !== '' ? props.id : qualifiedName;
  if (tool.recordKey !== null && tool.recordKey !== recordKey) {
    removeToolRecord(tool.recordKey);
  }
  tool.recordKey = recordKey;
  upsertToolRecord({
    key: recordKey,
    qualifiedName,
    name,
    scopePath: path,
    description,
    inputSchema,
    annotations,
    safety,
    lifetime,
    source: 'tree',
    status,
    availability: {enabled, scopeAvailable, hidden, supported},
    error: errorMessage,
    ownerToken: tool,
  });
}

function walkChildren(
  children: Array<Instance>,
  path: $ReadOnlyArray<string>,
  scopeAvailable: boolean,
  hidden: boolean,
  target: ModelContextLike | null,
  seen: Set<ToolInstance>,
  toRegister: Array<PendingRegistration>,
): void {
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    // React only tells the nearest host instance about a Suspense toggle, so
    // hidden state is inherited while walking down.
    const childHidden = hidden || child.hidden;
    if (child.tag === 'scope') {
      const props = child.props;
      let childPath = path;
      if (Array.isArray(props.path) && props.path.length > 0) {
        // The implicit root scope carries the DOM tree's ToolScope path.
        childPath = childPath.concat(props.path);
      }
      if (typeof props.name === 'string' && props.name !== '') {
        childPath = childPath.concat(props.name);
      }
      const childAvailable = scopeAvailable && props.available !== false;
      walkChildren(
        child.children,
        childPath,
        childAvailable,
        childHidden,
        target,
        seen,
        toRegister,
      );
    } else {
      seen.add(child);
      child.container.knownTools.add(child);
      visitTool(child, path, scopeAvailable, childHidden, target, toRegister);
    }
  }
}

// Reconciles browser registrations and registry records with the committed
// tree. Aborts happen before any new registration so a renamed or moved tool
// never briefly coexists with its previous self.
export function flushToolTree(container: Container): void {
  const target = container.getTarget();
  const seen: Set<ToolInstance> = new Set();
  const toRegister: Array<PendingRegistration> = [];
  batchToolRecordUpdates(() => {
    walkChildren(container.children, [], true, false, target, seen, toRegister);
    const removed: Array<ToolInstance> = [];
    container.knownTools.forEach(tool => {
      if (!seen.has(tool)) {
        removed.push(tool);
      }
    });
    for (let i = 0; i < removed.length; i++) {
      const tool = removed[i];
      abortRegistration(tool);
      if (tool.recordKey !== null) {
        removeToolRecord(tool.recordKey);
        tool.recordKey = null;
      }
      container.knownTools.delete(tool);
    }
    if (target !== null) {
      for (let i = 0; i < toRegister.length; i++) {
        registerPending(target, toRegister[i]);
      }
    }
  });
}

/** Host config */

export function getPublicInstance(instance: Instance): PublicInstance {
  return instance;
}

export function getRootHostContext(rootContainer: Container): HostContext {
  return NO_CONTEXT;
}

export function getChildHostContext(
  parentHostContext: HostContext,
  type: Type,
): HostContext {
  return NO_CONTEXT;
}

export function prepareForCommit(containerInfo: Container): null | Object {
  return null;
}

export function resetAfterCommit(containerInfo: Container): void {
  if (!containerInfo.dirty) {
    return;
  }
  containerInfo.dirty = false;
  flushToolTree(containerInfo);
}

export function createInstance(
  type: Type,
  props: Props,
  rootContainer: Container,
  hostContext: HostContext,
  internalInstanceHandle: Object,
): Instance {
  rootContainer.dirty = true;
  switch (type) {
    case 'tool':
      return {
        tag: 'tool',
        props,
        parent: null,
        container: rootContainer,
        hidden: false,
        registration: null,
        failedSignature: null,
        failedMessage: null,
        recordKey: null,
        warnedInvalid: false,
        fiber: internalInstanceHandle,
      };
    case 'scope':
      return {
        tag: 'scope',
        props,
        parent: null,
        container: rootContainer,
        hidden: false,
        children: [],
        fiber: internalInstanceHandle,
      };
    default:
      throw new Error(
        'react-webmcp does not support the element type "' +
          // eslint-disable-next-line react-internal/safe-string-coercion
          String(type) +
          '". A <ToolTree> can only contain <Tool> and <Scope> elements.',
      );
  }
}

export function cloneMutableInstance(
  instance: Instance,
  keepChildren: boolean,
): Instance {
  return instance;
}

export function appendInitialChild(
  parentInstance: Instance,
  child: Instance | TextInstance,
): void {
  attachChild(assertScope(parentInstance), child as any, null);
}

export function finalizeInitialChildren(
  instance: Instance,
  type: Type,
  props: Props,
  hostContext: HostContext,
): boolean {
  return false;
}

export function shouldSetTextContent(type: Type, props: Props): boolean {
  return false;
}

export function createTextInstance(
  text: string,
  rootContainer: Container,
  hostContext: HostContext,
  internalInstanceHandle: Object,
): TextInstance {
  throw new Error(
    'react-webmcp: Text is not allowed inside a <ToolTree>. Only <Tool> and ' +
      '<Scope> elements can be rendered into a tool tree. Received: "' +
      text +
      '".',
  );
}

export function cloneMutableTextInstance(
  textInstance: TextInstance,
): TextInstance {
  return textInstance;
}

export function createFragmentInstance(fiber: Object): null {
  return null;
}

export function updateFragmentInstanceFiber(
  fiber: Object,
  instance: FragmentInstanceType,
): void {}

export function commitNewChildToFragmentInstance(
  child: Instance,
  fragmentInstance: FragmentInstanceType,
): void {}

export function deleteChildFromFragmentInstance(
  child: Instance,
  fragmentInstance: FragmentInstanceType,
): void {}

export const scheduleTimeout = setTimeout;
export const cancelTimeout = clearTimeout;
export const noTimeout: -1 = -1;

let currentUpdatePriority: EventPriority = NoEventPriority;

export function setCurrentUpdatePriority(newPriority: EventPriority): void {
  currentUpdatePriority = newPriority;
}

export function getCurrentUpdatePriority(): EventPriority {
  return currentUpdatePriority;
}

export function resolveUpdatePriority(): EventPriority {
  return currentUpdatePriority || DefaultEventPriority;
}

export function trackSchedulerEvent(): void {}

export function resolveEventType(): null | string {
  return null;
}

export function resolveEventTimeStamp(): number {
  return -1.1;
}

export function shouldAttemptEagerTransition(): boolean {
  return false;
}

// The tool tree always lives inside another renderer's tree (react-dom).
export const isPrimaryRenderer = false;

// Registration is driven by the host app's own updates; no act() warnings.
export const warnsIfNotActing = false;

export const supportsMutation = true;

export function appendChild(
  parentInstance: Instance,
  child: Instance | TextInstance,
): void {
  attachChild(assertScope(parentInstance), child as any, null);
}

export function appendChildToContainer(
  container: Container,
  child: Instance | TextInstance,
): void {
  attachChild(container, child as any, null);
}

export function insertBefore(
  parentInstance: Instance,
  child: Instance | TextInstance,
  beforeChild: Instance | TextInstance,
): void {
  attachChild(assertScope(parentInstance), child as any, beforeChild as any);
}

export function insertInContainerBefore(
  container: Container,
  child: Instance | TextInstance,
  beforeChild: Instance | TextInstance,
): void {
  attachChild(container, child as any, beforeChild as any);
}

export function removeChild(
  parentInstance: Instance,
  child: Instance | TextInstance,
): void {
  const instance: Instance = child as any;
  detachChild(instance);
  instance.container.dirty = true;
}

export function removeChildFromContainer(
  container: Container,
  child: Instance | TextInstance,
): void {
  detachChild(child as any);
  container.dirty = true;
}

export function resetTextContent(instance: Instance): void {}

export function commitTextUpdate(
  textInstance: TextInstance,
  oldText: string,
  newText: string,
): void {}

export function commitMount(
  instance: Instance,
  type: Type,
  newProps: Props,
  internalInstanceHandle: Object,
): void {}

export function commitUpdate(
  instance: Instance,
  type: Type,
  oldProps: Props,
  newProps: Props,
  internalInstanceHandle: Object,
): void {
  instance.props = newProps;
  const keys =
    instance.tag === 'tool' ? TOOL_VISIBLE_PROPS : SCOPE_VISIBLE_PROPS;
  if (didVisiblePropsChange(keys, oldProps, newProps)) {
    instance.container.dirty = true;
  }
}

export function hideInstance(instance: Instance): void {
  instance.hidden = true;
  instance.container.dirty = true;
}

export function hideTextInstance(textInstance: TextInstance): void {}

export function unhideInstance(instance: Instance, props: Props): void {
  instance.hidden = false;
  instance.container.dirty = true;
}

export function unhideTextInstance(
  textInstance: TextInstance,
  text: string,
): void {}

export function clearContainer(container: Container): void {
  for (let i = 0; i < container.children.length; i++) {
    container.children[i].parent = null;
  }
  container.children = [];
  container.dirty = true;
}

export function getCurrentGestureOffset(provider: GestureTimeline): number {
  throw new Error(
    'startGestureTransition is not supported by the react-webmcp tool tree.',
  );
}

export function getInstanceFromNode(node: mixed): Object | null {
  return null;
}

export function beforeActiveInstanceBlur(
  internalInstanceHandle: Object,
): void {}

export function afterActiveInstanceBlur(): void {}

export function preparePortalMount(portalInstance: mixed): void {}

export function detachDeletedInstance(node: Instance): void {}

export function requestPostPaintCallback(
  callback: (time: number) => void,
): void {}

export function maySuspendCommit(type: Type, props: Props): boolean {
  return false;
}

export function maySuspendCommitOnUpdate(
  type: Type,
  oldProps: Props,
  newProps: Props,
): boolean {
  return false;
}

export function maySuspendCommitInSyncRender(
  type: Type,
  props: Props,
): boolean {
  return false;
}

export function preloadInstance(
  instance: Instance,
  type: Type,
  props: Props,
): boolean {
  return true;
}

export opaque type SuspendedState = null;

export function startSuspendingCommit(): SuspendedState {
  return null;
}

export function suspendInstance(
  state: SuspendedState,
  instance: Instance,
  type: Type,
  props: Props,
): void {}

export function suspendOnActiveViewTransition(
  state: SuspendedState,
  container: Container,
): void {}

export function waitForCommitToBeReady(
  state: SuspendedState,
  timeoutOffset: number,
): null {
  return null;
}

export function getSuspendedCommitReason(
  state: SuspendedState,
  rootContainer: Container,
): null | string {
  return null;
}

export const NotPendingTransition: TransitionStatus = null;
export const HostTransitionContext: ReactContext<TransitionStatus> = {
  $$typeof: REACT_CONTEXT_TYPE,
  Provider: null as any,
  Consumer: null as any,
  _currentValue: NotPendingTransition,
  _currentValue2: NotPendingTransition,
  _threadCount: 0,
};

export function resetFormInstance(form: Instance): void {}
