import assert from 'node:assert/strict';
import test from 'node:test';

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['HTMLElement', 'Node', 'KeyboardEvent'],
  actEnvironment: false,
});
globalThis.HTMLElement.prototype.scrollIntoView = () => {};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.requestAnimationFrame = (callback) => window.setTimeout(callback, 0);

const { ModelCatalog } = await import('./model-catalog.tsx');

const FAVORITES = 'mixdog.desktop-favorite-models';
const RECENTS = 'mixdog.desktop-recent-models';
const alpha = { provider: 'openai', model: 'gpt-alpha', display: 'Alpha' };
const beta = { provider: 'openai', model: 'gpt-beta', display: 'Beta' };
const shared = { provider: 'openai', model: 'shared-id', display: 'Shared' };
const sharedOther = { provider: 'anthropic', model: 'shared-id', display: 'Shared' };
const keyOf = (option) => `model:${option.provider}:${option.model}`;

let host;
let root;
let selected;
let closed;

test.beforeEach(() => {
  window.localStorage.clear();
  selected = [];
  closed = 0;
});
test.afterEach(async () => {
  if (root) await act(async () => root.unmount());
  host?.remove();
  root = host = undefined;
});

async function mount(models, props = {}) {
  host = document.createElement('main');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      React.createElement(ModelCatalog, {
        models,
        provider: 'openai',
        model: alpha.model,
        onSelect: (option) => selected.push(keyOf(option)),
        onClose: () => {
          closed += 1;
        },
        ...props,
      })
    )
  );
}
const sections = () =>
  [...host.querySelectorAll('.model-group')].map((group) => ({
    title: group.querySelector('h3').textContent.trim(),
    rows: [...group.querySelectorAll('[role="option"]')].map((row) => row.dataset.rowKey),
  }));
const star = (option, scope = '') => host.querySelector(`.model-favorite-toggle[data-row-key="${scope}${keyOf(option)}"]`);
const stored = () => JSON.parse(window.localStorage.getItem(FAVORITES) || '[]');
const click = (element) => act(async () => element.click());
const press = (element, key) =>
  act(async () => {
    element.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });

test('a star adds and removes a favorite without selecting, closing, or touching recents', async () => {
  window.localStorage.setItem(RECENTS, JSON.stringify([keyOf(beta)]));
  await mount([alpha, beta]);
  assert.ok(!sections().some((section) => section.title === 'Favorites'));
  assert.match(star(alpha).getAttribute('aria-label'), /^Add .*Alpha.* to favorites$/);

  await click(star(alpha));
  assert.deepEqual(stored(), [keyOf(alpha)]);
  assert.deepEqual(sections()[0], { title: 'Favorites', rows: [`favorite:${keyOf(alpha)}`] });
  assert.equal(sections()[1].title, 'Recent');
  assert.match(star(alpha, 'favorite:').getAttribute('aria-label'), /^Remove .*Alpha.* from favorites$/);
  assert.equal(star(alpha).getAttribute('aria-label'), star(alpha, 'favorite:').getAttribute('aria-label'));

  await click(star(alpha, 'favorite:'));
  assert.deepEqual(stored(), []);
  assert.ok(!sections().some((section) => section.title === 'Favorites'));
  assert.deepEqual(selected, []);
  assert.equal(closed, 0);
  assert.deepEqual(JSON.parse(window.localStorage.getItem(RECENTS)), [keyOf(beta)]);
});

test('favorites persist across a remount', async () => {
  await mount([alpha, beta]);
  await click(star(beta));
  await act(async () => root.unmount());
  host.remove();
  await mount([alpha, beta]);
  assert.deepEqual(sections()[0].rows, [`favorite:${keyOf(beta)}`]);
});

test('the same model id under two providers is two independent favorites', async () => {
  await mount([shared, sharedOther]);
  await click(star(sharedOther));
  assert.deepEqual(stored(), [keyOf(sharedOther)]);
  const [favorites, ...providers] = sections();
  assert.deepEqual(favorites.rows, [`favorite:${keyOf(sharedOther)}`]);
  assert.equal(providers.length, 2, 'provider sections stay');
  assert.equal(star(shared).dataset.favorite, 'false');
  assert.equal(star(sharedOther).dataset.favorite, 'true');
});

test('a model in Favorites, Recent and its provider section keeps all three rows in sync', async () => {
  window.localStorage.setItem(RECENTS, JSON.stringify([keyOf(alpha)]));
  window.localStorage.setItem(FAVORITES, JSON.stringify([keyOf(alpha)]));
  await mount([alpha, beta]);
  assert.deepEqual(
    sections().map((section) => section.rows[0]),
    [`favorite:${keyOf(alpha)}`, `recent:${keyOf(alpha)}`, keyOf(alpha)]
  );
  await click(star(alpha, 'recent:'));
  assert.deepEqual(stored(), []);
  assert.equal(star(alpha).dataset.favorite, 'false');
});

test('search filters favorites along with the other sections', async () => {
  window.localStorage.setItem(FAVORITES, JSON.stringify([keyOf(alpha), keyOf(beta)]));
  await mount([alpha, beta]);
  const input = host.querySelector('input[type="text"]');
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setValue.call(input, 'beta');
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  assert.deepEqual(sections()[0], { title: 'Favorites', rows: [`favorite:${keyOf(beta)}`] });
  assert.equal(host.querySelectorAll('.model-group').length, 2);
});

test('unavailable favorites are hidden but their saved keys survive other changes', async () => {
  const gone = { provider: 'openai', model: 'gone', display: 'Gone' };
  window.localStorage.setItem(FAVORITES, JSON.stringify([keyOf(gone), keyOf(alpha)]));
  await mount([alpha, beta]);
  assert.deepEqual(sections()[0].rows, [`favorite:${keyOf(alpha)}`]);
  await click(star(beta));
  assert.deepEqual(stored(), [keyOf(gone), keyOf(alpha), keyOf(beta)]);
  await click(star(alpha, 'favorite:'));
  assert.deepEqual(stored(), [keyOf(gone), keyOf(beta)]);
});

test('arrow keys and Enter still choose models; stars are not options and choose nothing', async () => {
  window.localStorage.setItem(FAVORITES, JSON.stringify([keyOf(beta)]));
  await mount([alpha, beta]);
  const input = host.querySelector('input[type="text"]');
  await press(input, 'ArrowDown');
  const options = [...host.querySelectorAll('[role="option"]')];
  assert.equal(document.activeElement, options[1], 'search navigation starts on the active route');
  assert.equal(options[0].dataset.rowKey, `favorite:${keyOf(beta)}`);
  await press(document.activeElement, 'ArrowDown');
  assert.equal(document.activeElement, options[2]);

  star(beta).focus();
  await press(star(beta), 'ArrowDown');
  assert.equal(document.activeElement.getAttribute('role'), 'option', 'arrows from a star re-enter the options');
  assert.equal(document.activeElement.dataset.rowKey, keyOf(beta));
  assert.deepEqual(selected, []);
  assert.equal(closed, 0);

  await act(async () => options[0].click());
  assert.deepEqual(selected, [keyOf(beta)]);
  assert.equal(closed, 1);
});

test('removing the focused Favorites star hands focus to a surviving star instead of losing it', async () => {
  window.localStorage.setItem(FAVORITES, JSON.stringify([keyOf(alpha)]));
  await mount([alpha, beta]);
  const fav = star(alpha, 'favorite:');
  fav.focus();
  await click(fav);
  await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
  assert.equal(document.activeElement, star(alpha));
});

test('options contain no controls and listboxes own only options', async () => {
  window.localStorage.setItem(FAVORITES, JSON.stringify([keyOf(alpha)]));
  await mount([alpha, beta]);
  assert.equal(host.querySelectorAll('[role="option"] button, [role="option"] [role="button"]').length, 0);
  const listboxes = [...host.querySelectorAll('[role="listbox"]')];
  assert.ok(listboxes.length >= 2);
  for (const listbox of listboxes) {
    assert.ok(listbox.getAttribute('aria-labelledby'));
    assert.deepEqual([...listbox.children].map((child) => child.getAttribute('role')), Array(listbox.children.length).fill('option'));
  }
});

test('favorites can still be toggled in memory when storage is unavailable', async () => {
  await mount([alpha, beta]);
  const prototype = Object.getPrototypeOf(window.localStorage);
  const getItem = prototype.getItem;
  const setItem = prototype.setItem;
  prototype.getItem = function (key) {
    if (key === FAVORITES) throw new Error('storage unavailable');
    return getItem.call(this, key);
  };
  prototype.setItem = function (key, value) {
    if (key === FAVORITES) throw new Error('storage unavailable');
    return setItem.call(this, key, value);
  };
  try {
    await click(star(alpha));
    assert.equal(star(alpha).dataset.favorite, 'true');
    await click(star(alpha));
    assert.equal(star(alpha).dataset.favorite, 'false');
    assert.deepEqual(selected, []);
    assert.equal(closed, 0);
  } finally {
    prototype.getItem = getItem;
    prototype.setItem = setItem;
  }
});
