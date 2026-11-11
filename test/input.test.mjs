import test from 'node:test';
import assert from 'node:assert/strict';
import { validateInput } from '../src/input.mjs';

const controls = { keys: ['ArrowLeft', 'ArrowRight', 'Space'], buttons: ['left', 'right'], viewport: { width: 800, height: 600 } };

test('bounded player inputs reject state edits and unbounded time before execution', () => {
  for (const input of [
    { ticks: 1, setGold: 999 },
    { ticks: 0 },
    { ticks: 241 },
    { ticks: 1, held: ['F12'] },
    { ticks: 1, held: ['Space', 'Space'] },
    { ticks: 1, pointer: { x: 800, y: 10 } }
  ]) assert.throws(() => validateInput(input, controls));
});

test('opposing player keys remain testable, including mouse buttons and zero coordinates', () => {
  const value = { held: ['ArrowLeft', 'ArrowRight'], buttons: ['left', 'right'], pointer: { x: 0, y: 0 }, ticks: 1 };
  assert.deepEqual(validateInput(value, controls), value);
});
