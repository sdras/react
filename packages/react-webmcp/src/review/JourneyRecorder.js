/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

// Records what a developer does on the page as journey steps for
// `yarn infer-tools trace --journey`: clicks on buttons and links become
// {click, near?} steps, committed edits to fields become {fill, value} steps.
// Tool calls cannot be observed from the page, so those steps are added by
// hand. Pure helpers are exported for tests; the overlay drives
// startJourneyRecording.

export type RecordedStep =
  | {click: string, near?: string}
  | {fill: string, value: string};

export type RecordedJourney = {
  name: string,
  description: string,
  steps: Array<RecordedStep>,
};

export type RecordingHandle = {
  stop: () => Array<RecordedStep>,
  steps: () => $ReadOnlyArray<RecordedStep>,
};

const CLICKABLE = 'button, a[href], [role="button"], input[type="submit"]';
const FIELD = 'input, textarea, select';
const NEAR_CONTAINERS = 'li, tr, fieldset, form, section, article';

function normalize(text: string | null | void): string {
  return text == null ? '' : text.replace(/\s+/g, ' ').trim();
}

export function accessibleName(element: Element): string {
  const aria = element.getAttribute('aria-label');
  if (aria != null && normalize(aria) !== '') {
    return normalize(aria);
  }
  if (
    element.tagName === 'INPUT' &&
    element.getAttribute('type') === 'submit'
  ) {
    return normalize(element.getAttribute('value')) || 'Submit';
  }
  return normalize(element.textContent);
}

// Text from the nearest container that would tell two same-named buttons
// apart: the container's text without the button's own label.
function nearHint(element: Element, label: string): string | null {
  const container = element.closest(NEAR_CONTAINERS);
  if (container == null) {
    return null;
  }
  let text = normalize(container.textContent).replace(label, '').trim();
  if (text === '') {
    const field = container.querySelector('[placeholder], [aria-label]');
    if (field != null) {
      text = normalize(
        field.getAttribute('placeholder') || field.getAttribute('aria-label'),
      );
    }
  }
  if (text === '') {
    return null;
  }
  return text.length > 40 ? text.slice(0, 40).trim() : text;
}

// Whether other clickables on the page share this label, so a `near` hint is
// needed for trace to pick the right one.
function isAmbiguous(element: Element, label: string): boolean {
  const all = element.ownerDocument.querySelectorAll(CLICKABLE);
  let count = 0;
  for (let i = 0; i < all.length; i++) {
    if (accessibleName(all[i]) === label) {
      count++;
    }
  }
  return count > 1;
}

export function describeClick(target: Element): RecordedStep | null {
  const element = target.closest(CLICKABLE);
  if (element == null) {
    return null;
  }
  const label = accessibleName(element);
  if (label === '') {
    return null;
  }
  const step: {click: string, near?: string} = {click: label};
  if (isAmbiguous(element, label)) {
    const near = nearHint(element, label);
    if (near != null) {
      step.near = near;
    }
  }
  return step;
}

export function fieldLabel(field: Element): string {
  const own =
    field.getAttribute('placeholder') ||
    field.getAttribute('aria-label') ||
    field.getAttribute('name');
  if (own != null && normalize(own) !== '') {
    return normalize(own);
  }
  const id = field.getAttribute('id');
  if (id != null && id !== '') {
    const labels = field.ownerDocument.querySelectorAll('label[for]');
    for (let i = 0; i < labels.length; i++) {
      if (labels[i].getAttribute('for') === id) {
        return normalize(labels[i].textContent);
      }
    }
  }
  const wrapping = field.closest('label');
  return wrapping == null ? '' : normalize(wrapping.textContent);
}

export function describeFill(target: Element): RecordedStep | null {
  if (!target.matches(FIELD)) {
    return null;
  }
  const label = fieldLabel(target);
  if (label === '') {
    return null;
  }
  const inputType = target.getAttribute('type');
  const value =
    target instanceof HTMLInputElement &&
    (inputType === 'checkbox' || inputType === 'radio')
      ? target.checked
        ? 'on'
        : 'off'
      : (target as any).value;
  return {fill: label, value: typeof value === 'string' ? value : ''};
}

// Installs capture-phase listeners on the document. Events inside `ignore`
// (the overlay and the recording indicator) are skipped. Returns a handle
// that stops recording and yields the steps.
export function startJourneyRecording(options: {
  document: Document,
  ignore?: (target: Element) => boolean,
  onStep?: (step: RecordedStep, steps: $ReadOnlyArray<RecordedStep>) => void,
}): RecordingHandle {
  const doc = options.document;
  const steps: Array<RecordedStep> = [];
  const ignore = options.ignore;

  function push(step: RecordedStep) {
    const previous = steps[steps.length - 1];
    // A field edited twice before any click keeps only its final value.
    if (
      previous != null &&
      step.fill !== undefined &&
      previous.fill === step.fill
    ) {
      steps[steps.length - 1] = step;
    } else {
      steps.push(step);
    }
    if (options.onStep != null) {
      options.onStep(step, steps);
    }
  }

  function onClick(event: Event) {
    const target = event.target;
    if (!(target instanceof Element) || (ignore != null && ignore(target))) {
      return;
    }
    const step = describeClick(target);
    if (step !== null) {
      push(step);
    }
  }

  function onChange(event: Event) {
    const target = event.target;
    if (!(target instanceof Element) || (ignore != null && ignore(target))) {
      return;
    }
    const step = describeFill(target);
    if (step !== null) {
      push(step);
    }
  }

  doc.addEventListener('click', onClick, true);
  doc.addEventListener('change', onChange, true);
  return {
    steps: () => steps,
    stop: () => {
      doc.removeEventListener('click', onClick, true);
      doc.removeEventListener('change', onChange, true);
      return steps.slice();
    },
  };
}

export function journeyFileName(name: string): string {
  return name.replace(/[^a-z0-9-]+/gi, '-').replace(/^-|-$/g, '') + '.json';
}
