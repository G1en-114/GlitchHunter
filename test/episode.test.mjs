import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { compileAction } from '../src/actions.mjs';
import { runEpisode, replayEpisode } from '../src/episode.mjs';
import { evaluate2048 } from '../src/inspect-2048.mjs';
import { createDshActionPolicy } from '../src/dsh-policy.mjs';

const config = { keys: ['ArrowLeft', 'ArrowRight'], buttons: [], viewport: { width: 100, height: 100 } };
function makeAdapter({ unchanged = false } = {}) {
  let value = 0, ticks = 0, held = [];
  const capture = () => ({
    observation: { held: [...held], buttons: [], tick: ticks, public: { score: value }, image: { mimeType: 'image/png', data: Buffer.from('fixture-image').toString('base64') } },
    verification: { available: true, state: { privateValue: value }, errors: [] },
    progress: { key: String(value), source: 'test-fixture' }
  });
  return {
    async reset() { value = 0; ticks = 0; held = []; return capture(); },
    async step(input) { ticks += input.ticks; held = input.held; if (!unchanged && held.includes('ArrowRight')) value++; return capture(); },
    async releaseAll() { held = []; return capture(); },
    async describe() { return { driver: 'test-fixture' }; }
  };
}
async function temporary(work) {
  const root = await mkdtemp(join(tmpdir(), 'glitchhunter-episode-'));
  try { await work(join(root, 'episode')); } finally { await rm(root, { recursive: true, force: true }); }
}

test('action compiler distinguishes a fresh tap from continued holding and neutral waiting', () => {
  assert.deepEqual(compileAction({ type: 'tap', key: 'ArrowRight' }, config, { held: ['ArrowRight'] }).map(input => input.held), [[], ['ArrowRight'], []]);
  assert.deepEqual(compileAction({ type: 'hold', held: ['ArrowLeft', 'ArrowRight'], ticks: 3 }, config)[0].held, ['ArrowLeft', 'ArrowRight']);
  assert.deepEqual(compileAction({ type: 'wait', ticks: 4 }, config)[0].held, []);
  assert.throws(() => compileAction({ type: 'hold', held: ['F12'], ticks: 1 }, config));
  assert.throws(() => compileAction({ type: 'tap', key: 'ArrowRight', ticks: 0 }, config));
});

test('verified task success completes the tap release and retains both atomic inputs', async () => temporary(async directory => {
  const adapter = makeAdapter();
  const result = await runEpisode({ adapter, directory, config, task: { id: 'reach-one' },
    policy: async ({ observation, ...context }) => {
      assert.equal('progress' in context, false);
      assert.equal('verification' in context, false);
      assert.equal('privateValue' in observation, false);
      return { type: 'tap', key: 'ArrowRight' };
    }, evaluate: capture => ({ status: capture.verification.state.privateValue >= 1 ? 'success' : 'running' })
  });
  assert.equal(result.status, 'success');
  assert.equal(result.steps, 2);
  const rows = (await readFile(join(directory, 'trace.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.at(-1).observation.held, []);
  assert.equal((await replayEpisode({ adapter, directory })).verified, true);
}));

test('no visible effect reaches stalled, while a model stop never certifies success', async () => temporary(async directory => {
  const adapter = makeAdapter({ unchanged: true });
  let previous;
  const result = await runEpisode({ adapter, directory, config, stallLimit: 2, policy: async ({ feedback }) => { previous = feedback; return { type: 'tap', key: 'ArrowLeft' }; } });
  assert.equal(previous.visualChanged, false);
  assert.equal(previous.consecutiveNoProgress, 1);
  assert.equal(result.status, 'stalled');
  assert.equal(result.metrics.noProgressActions, 2);
  const stopped = await runEpisode({ adapter, directory: directory + '-stop', config, policy: async () => null });
  assert.equal(stopped.status, 'policy-stopped');
}));

test('compound actions are not partially executed when the tick budget cannot include release', async () => temporary(async directory => {
  const result = await runEpisode({ adapter: makeAdapter(), directory, config, maxTicks: 6, policy: async () => ({ type: 'tap', key: 'ArrowRight' }) });
  assert.equal(result.reason, 'tick-budget');
  assert.equal(result.steps, 0);
  assert.equal(result.metrics.actions, 0);
}));

test('invalid action feedback allows correction; persistent invalid input terminates with evidence', async () => temporary(async directory => {
  let calls = 0;
  const result = await runEpisode({ adapter: makeAdapter(), directory, config, maxActions: 1, policy: async ({ feedback }) => {
    if (++calls === 1) return { type: 'tap', key: 'F12' };
    assert.equal(feedback.status, 'rejected');
    return { type: 'tap', key: 'ArrowRight' };
  } });
  assert.equal(result.metrics.rejectedActions, 1);
  assert.equal(result.metrics.actions, 1);
  const invalid = await runEpisode({ adapter: makeAdapter(), directory: directory + '-invalid', config, policy: async () => ({ type: 'unknown' }) });
  assert.equal(invalid.status, 'error');
  assert.equal(invalid.reason, 'rejected-action-budget');
  assert.equal(invalid.steps, 0);
}));

test('episode deadline aborts an active policy and saves a budget result', async () => temporary(async directory => {
  let aborted = false;
  const result = await runEpisode({ adapter: makeAdapter(), directory, config, maxDurationMs: 30, policy: ({ signal }) => new Promise((_accept, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
  }) });
  assert.equal(aborted, true);
  assert.equal(result.reason, 'wall-time-budget');
  assert.equal(result.steps, 0);
  assert.equal(JSON.parse(await readFile(join(directory, 'summary.json'), 'utf8')).status, 'budget-exhausted');
}));

test('held inputs are cleaned up with a zero-time trace record and replay correctly', async () => temporary(async directory => {
  const adapter = makeAdapter();
  const result = await runEpisode({ adapter, directory, config, maxActions: 1, policy: async () => ({ type: 'hold', held: ['ArrowRight'], ticks: 3 }) });
  assert.equal(result.cleanupSteps, 1);
  assert.equal(result.recordedSteps, 2);
  assert.equal(result.steps, 1);
  const rows = (await readFile(join(directory, 'trace.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows.at(-1).kind, 'release-all');
  assert.equal(rows[0].observation.tick, rows[1].observation.tick);
  assert.equal((await replayEpisode({ adapter, directory })).verified, true);
}));

test('a checker failure retains the executed input and produces an error summary', async () => temporary(async directory => {
  const result = await runEpisode({ adapter: makeAdapter(), directory, config, policy: async () => ({ type: 'tap', key: 'ArrowRight' }), check: () => { throw new Error('broken-checker'); } });
  assert.equal(result.status, 'error');
  assert.equal(result.steps, 1);
  assert.equal(result.error.message, 'broken-checker');
  const rows = (await readFile(join(directory, 'trace.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows[0].checkError, 'broken-checker');
}));

test('2048 task evaluator distinguishes target tile, game over and score-only progress', () => {
  const captured = (tile, over = false) => ({ observation: { public: { score: 999 } }, verification: { state: { saved: { grid: { cells: [[{ value: tile }]] }, score: 999 }, over } } });
  assert.equal(evaluate2048(captured(8), 16).status, 'running');
  assert.equal(evaluate2048(captured(16), 16).status, 'success');
  assert.equal(evaluate2048(captured(8, true), 16).status, 'failure');
  const prematureWin = captured(8);
  prematureWin.verification.state.won = true;
  assert.equal(evaluate2048(prematureWin, 16).reason, 'win-state-without-target-tile');
});

test('a partial adapter failure is journaled and cleanup uses actual input state', async () => temporary(async directory => {
  const adapter = makeAdapter();
  let actualHeld = [];
  const step = adapter.step;
  adapter.inputState = () => ({ held: actualHeld, buttons: [] });
  adapter.step = async input => { actualHeld = input.held; await step(input); throw new Error('capture-failed-after-input'); };
  const release = adapter.releaseAll;
  adapter.releaseAll = async () => { actualHeld = []; return release(); };
  const result = await runEpisode({ adapter, directory, config, policy: async () => ({ type: 'tap', key: 'ArrowRight' }) });
  assert.equal(result.status, 'error');
  assert.equal(result.steps, 0);
  assert.equal(result.cleanupSteps, 1);
  assert.deepEqual(actualHeld, []);
  const events = (await readFile(join(directory, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(events.at(-1).type, 'input-failed');
  assert.equal(events.at(-1).mayHaveApplied, true);
  assert.equal((await replayEpisode({ adapter, directory })).verified, false);
}));

test('deadline waits for cooperative model cleanup before recording final call metrics', async () => temporary(async directory => {
  const decisions = directory + '-decisions';
  const policy = await createDshActionPolicy({ directory: decisions, controls: config, task: { description: 'Play' }, runTurn: ({ signal }) => new Promise((_accept, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) });
  const result = await runEpisode({ adapter: makeAdapter(), directory, config, policy, maxDurationMs: 40 });
  assert.equal(result.reason, 'wall-time-budget');
  assert.equal(result.metrics.policy.modelCalls, 1);
  assert.equal(result.metrics.policy.failedAttempts, 1);
  const error = JSON.parse(await readFile(join(decisions, '0001.attempt-1.error.json'), 'utf8'));
  assert.equal(error.code, 'WALL_TIME_BUDGET');
}));
