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

// What a field is for, by its name, id, label, placeholder or autocomplete
// value, when its type does not say. The hint is split into lowercase words
// first (camelCase, underscores and hyphens all become spaces) and matched by
// whole words, so "cardNumber", "credit card", "pin_code" and a bare "Card"
// are payment or credential fields while "discard_reason", "Postcard
// message" and "cardTitle" are not. A miss here records a secret into a
// journey file and a false positive silently drops a step, so the words
// below are the ones payment and credential forms use for their fields.
const SECRET_HINT =
  /passw|passphrase|secret|cvv|cvc|security ?code|^card$|\b(?:credit|debit|payment|gift) ?card\b|\bcard ?(?:number|num|no|holder|code|cvv|cvc|exp|expiry|expiration|pan)\b|\bon card\b|\bcc ?(?:num|number|no|exp|expiry|cvv|cvc)\b|\botp\b|\bssn\b|\bpin\b/;
const SECRET_HINT_ATTRIBUTES = ['name', 'id', 'aria-label', 'placeholder'];

function secretHintWords(hint: string): string {
  return hint
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
}

// Exported for tests: whether a name, id, label or placeholder reads as a
// password or payment field.
export function isSecretHint(hint: string): boolean {
  return SECRET_HINT.test(secretHintWords(hint));
}

// Secrets never reach a journey file: a password or payment field yields no
// step, so the developer adds it by hand with a value that can be committed.
// A "show password" toggle flips `type` to text before the change event
// fires, so the recorder also remembers every field it saw as a password
// (`everSecret`), and the hints above catch unlabeled secret inputs.
export function isSecretField(
  element: Element,
  everSecret?: WeakSet<Element>,
): boolean {
  if (everSecret !== undefined && everSecret.has(element)) {
    return true;
  }
  const type = element.getAttribute('type');
  if (type != null && type.toLowerCase() === 'password') {
    return true;
  }
  const autocomplete = element.getAttribute('autocomplete');
  if (
    autocomplete != null &&
    /(^|\s)(cc-|one-time-code|current-password|new-password)/i.test(
      autocomplete,
    )
  ) {
    return true;
  }
  for (let i = 0; i < SECRET_HINT_ATTRIBUTES.length; i++) {
    const hint = element.getAttribute(SECRET_HINT_ATTRIBUTES[i]);
    if (hint != null && isSecretHint(hint)) {
      return true;
    }
  }
  return false;
}

export function describeFill(
  target: Element,
  everSecret?: WeakSet<Element>,
): RecordedStep | null {
  if (!target.matches(FIELD) || isSecretField(target, everSecret)) {
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
  // Fields that were a password field at any point while recording.
  const everSecret: WeakSet<Element> = new WeakSet();

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
    const step = describeFill(target, everSecret);
    if (step !== null) {
      push(step);
    }
  }

  // Seen while the field is focused or typed into, before a toggle can
  // change its type.
  function onFieldActivity(event: Event) {
    const target = event.target;
    if (target instanceof Element && isSecretField(target)) {
      everSecret.add(target);
    }
  }

  doc.addEventListener('click', onClick, true);
  doc.addEventListener('change', onChange, true);
  doc.addEventListener('focusin', onFieldActivity, true);
  doc.addEventListener('input', onFieldActivity, true);
  return {
    steps: () => steps,
    stop: () => {
      doc.removeEventListener('click', onClick, true);
      doc.removeEventListener('change', onChange, true);
      doc.removeEventListener('focusin', onFieldActivity, true);
      doc.removeEventListener('input', onFieldActivity, true);
      return steps.slice();
    },
  };
}

export function journeyFileName(name: string): string {
  return name.replace(/[^a-z0-9-]+/gi, '-').replace(/^-|-$/g, '') + '.json';
}
