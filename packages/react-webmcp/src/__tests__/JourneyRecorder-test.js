/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails react-core
 */

'use strict';

const Recorder = require('react-webmcp/src/review/JourneyRecorder');

function html(markup) {
  document.body.innerHTML = markup;
}

function setValue(element, value) {
  const prototype =
    element.tagName === 'TEXTAREA'
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
}

describe('JourneyRecorder', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('describes clicks by accessible name, with a hint when names repeat', () => {
    html(`
      <ul>
        <li>Green tea <button type="button">Add</button></li>
        <li>Earl Grey <button type="button">Add</button></li>
      </ul>
      <button type="button" aria-label="Close dialog"><svg></svg></button>
      <form><input placeholder="Something to do" /><button type="submit">Save</button></form>
      <div><span>plain text</span></div>
    `);
    const adds = document.querySelectorAll('li button');
    expect(Recorder.describeClick(adds[1])).toEqual({
      click: 'Add',
      near: 'Earl Grey',
    });
    expect(
      Recorder.describeClick(document.querySelector('[aria-label]')),
    ).toEqual({
      click: 'Close dialog',
    });
    expect(
      Recorder.describeClick(document.querySelector('[type="submit"]')),
    ).toEqual({
      click: 'Save',
    });
    expect(Recorder.describeClick(document.querySelector('span'))).toBe(null);
  });

  it('describes field edits by placeholder, aria-label, label or name', () => {
    html(`
      <input placeholder="Email" value="" />
      <label for="qty">Quantity</label><input id="qty" type="number" />
      <label>Notes <textarea name="notes"></textarea></label>
      <input type="checkbox" aria-label="Gift wrap" />
      <input />
    `);
    const [email, qty, gift, anonymous] = document.querySelectorAll('input');
    const notes = document.querySelector('textarea');
    setValue(email, 'a@b.c');
    expect(Recorder.describeFill(email)).toEqual({
      fill: 'Email',
      value: 'a@b.c',
    });
    setValue(qty, '2');
    expect(Recorder.describeFill(qty)).toEqual({fill: 'Quantity', value: '2'});
    setValue(notes, 'hi');
    expect(Recorder.describeFill(notes)).toEqual({fill: 'notes', value: 'hi'});
    gift.checked = true;
    expect(Recorder.describeFill(gift)).toEqual({
      fill: 'Gift wrap',
      value: 'on',
    });
    expect(Recorder.describeFill(anonymous)).toBe(null);
  });

  it('never records password or payment fields', () => {
    html(`
      <input type="password" placeholder="Password" />
      <input placeholder="Card number" autocomplete="cc-number" />
      <input placeholder="Code" autocomplete="one-time-code" />
      <input placeholder="Email" autocomplete="email" />
      <input name="password" autocomplete="off" placeholder="Secret" />
      <input id="cvv" placeholder="3 digits" />
      <input aria-label="PIN" />
      <input placeholder="Shipping address" />
    `);
    const [password, card, code, email, named, cvv, pin, shipping] =
      document.querySelectorAll('input');
    setValue(password, 'hunter2');
    setValue(card, '4242');
    setValue(code, '123456');
    setValue(email, 'a@b.c');
    setValue(named, 'hunter2');
    setValue(cvv, '123');
    setValue(pin, '0000');
    setValue(shipping, '1 Main St');
    expect(Recorder.isSecretField(password)).toBe(true);
    expect(Recorder.describeFill(password)).toBe(null);
    expect(Recorder.describeFill(card)).toBe(null);
    expect(Recorder.describeFill(code)).toBe(null);
    expect(Recorder.describeFill(email)).toEqual({
      fill: 'Email',
      value: 'a@b.c',
    });
    // Unlabeled secrets are caught by their name, id or label.
    expect(Recorder.describeFill(named)).toBe(null);
    expect(Recorder.describeFill(cvv)).toBe(null);
    expect(Recorder.describeFill(pin)).toBe(null);
    expect(Recorder.describeFill(shipping)).toEqual({
      fill: 'Shipping address',
      value: '1 Main St',
    });
  });

  it('keeps a password out of the journey after a show-password toggle', () => {
    html(`
      <input type="password" placeholder="Passphrase" />
      <button type="button">Show</button>
    `);
    const field = document.querySelector('input');
    const handle = Recorder.startJourneyRecording({document});
    field.dispatchEvent(new Event('focusin', {bubbles: true}));
    setValue(field, 'hunter2');
    field.dispatchEvent(new Event('input', {bubbles: true}));
    // The toggle flips the type before the edit is committed.
    field.setAttribute('type', 'text');
    field.dispatchEvent(new Event('change', {bubbles: true}));
    expect(Recorder.isSecretField(field)).toBe(false);
    expect(handle.stop()).toEqual([]);
  });

  it('records clicks and committed edits until stopped, ignoring what it is told to', () => {
    html(`
      <div class="overlay"><button type="button">Overlay button</button></div>
      <input placeholder="Something to do" />
      <button type="button">Add</button>
      <button type="button">Clear</button>
    `);
    const seen = [];
    const handle = Recorder.startJourneyRecording({
      document,
      ignore: target => target.closest('.overlay') != null,
      onStep: (step, steps) => seen.push(steps.length),
    });
    const input = document.querySelector('input');
    setValue(input, 'Buy');
    input.dispatchEvent(new Event('change', {bubbles: true}));
    setValue(input, 'Buy tea');
    input.dispatchEvent(new Event('change', {bubbles: true}));
    document.querySelector('.overlay button').click();
    document.querySelectorAll('button')[1].click();
    document.querySelectorAll('button')[2].click();
    expect(handle.steps()).toEqual([
      {fill: 'Something to do', value: 'Buy tea'},
      {click: 'Add'},
      {click: 'Clear'},
    ]);
    expect(seen).toEqual([1, 1, 2, 3]);
    const steps = handle.stop();
    document.querySelectorAll('button')[1].click();
    expect(handle.steps()).toHaveLength(3);
    expect(steps).toHaveLength(3);
  });

  it('names journey files safely', () => {
    expect(Recorder.journeyFileName('journey-2026-11-01-17-00')).toBe(
      'journey-2026-11-01-17-00.json',
    );
    expect(Recorder.journeyFileName('Buy tea / checkout!')).toBe(
      'Buy-tea-checkout.json',
    );
  });
});
