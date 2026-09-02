import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureScroll, restoreScroll } from '../docs/ui/bundle.js';

const box = (key, scrollTop) => ({ dataset: { scroll: key }, scrollTop });

test('restores each scroller to its saved offset by key, not position', () => {
  const saved = captureScroll([box('detail', 300), box('prompt', 120), box('result', 45)]);
  const rebuilt = [box('detail', 0), box('result', 0), box('prompt', 0)];
  restoreScroll(rebuilt, saved);
  assert.deepEqual(rebuilt.map((e) => e.scrollTop), [300, 45, 120]);
});

test('a scroller with no saved offset starts at the top', () => {
  const saved = captureScroll([box('detail', 300)]);
  const rebuilt = [box('detail', 0), box('result', 5)];
  restoreScroll(rebuilt, saved);
  assert.deepEqual(rebuilt.map((e) => e.scrollTop), [300, 0]);
});

test('a scroller that vanished is dropped without error', () => {
  const saved = captureScroll([box('detail', 300), box('result', 45)]);
  const rebuilt = [box('detail', 0)];
  restoreScroll(rebuilt, saved);
  assert.equal(rebuilt[0].scrollTop, 300);
});

test('an unscrolled scroller is restored to zero, not left where the rebuild put it', () => {
  const saved = captureScroll([box('prompt', 0)]);
  const rebuilt = [box('prompt', 77)];
  restoreScroll(rebuilt, saved);
  assert.equal(rebuilt[0].scrollTop, 0);
});
