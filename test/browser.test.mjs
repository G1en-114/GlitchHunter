import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserAdapter } from '../src/browser.mjs';
import { serveDirectory } from '../src/server.mjs';
import { inspect2048 } from '../src/inspect-2048.mjs';
import { runEpisode, replayEpisode } from '../src/episode.mjs';

test('real browser input, observation boundary, input release, seeded replay and divergence detection', { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'glitchhunter-test-'));
  const server = await serveDirectory(new URL('../third_party/2048', import.meta.url).pathname);
  const adapter = new BrowserAdapter({ inspect: inspect2048 });
  try {
    const config = { url: server.url, hz: 60, viewport: { width: 800, height: 900 }, keys: ['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown'], seed: 42, seededHarness: true, screenshotAnimations: 'disabled', buildId: 'fixture-build' };
    let calls = 0;
    const directory = join(root, 'episode');
    const result = await runEpisode({ adapter, directory, config, maxSteps: 8, policy: async ({ observation, remaining, ...other }) => {
      assert.equal('verification' in observation, false);
      assert.equal('state' in observation, false);
      assert.equal('verification' in other, false);
      assert.equal(observation.image.mimeType, 'image/png');
      assert.ok(Buffer.from(observation.image.data, 'base64').length > 1000);
      assert.ok(remaining.ticks > 0);
      const input = { held: calls % 2 ? [] : [config.keys[Math.floor(calls / 2)]], ticks: 12 };
      calls++;
      return input;
    } });
    assert.equal(result.steps, 8);
    assert.equal(result.ticks, 96);
    const trace = (await readFile(join(directory, 'trace.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(trace[1].observation.held, []);
    const initial = JSON.parse(await readFile(join(directory, 'meta.json'), 'utf8'));
    assert.notDeepEqual(initial.initial.verification.state.saved, trace.at(-1).verification.state.saved);
    assert.equal((await replayEpisode({ adapter, directory, buildId: 'fixture-build' })).verified, true);
    assert.equal((await replayEpisode({ adapter, directory, buildId: 'changed-build' })).reason, 'build-missing-or-mismatched');
    trace[2].verification.state.scoreText = 'incorrect-checkpoint';
    await writeFile(join(directory, 'trace.jsonl'), trace.map(line => JSON.stringify(line)).join('\n') + '\n');
    assert.deepEqual(await replayEpisode({ adapter, directory, buildId: 'fixture-build' }), { verified: false, divergenceAt: 3, reason: 'checkpoint-mismatch' });
    // A second episode cannot observe localStorage from the first one.
    const fresh = await adapter.reset(config);
    assert.deepEqual(fresh.verification, initial.initial.verification);
    assert.deepEqual(fresh.observation.held, []);
    const tiles = await adapter.page.locator('.tile-inner').evaluateAll(elements => elements.map(element => getComputedStyle(element).transform));
    assert.equal(tiles.length, 2);
    assert.ok(tiles.every(transform => transform !== 'matrix(0, 0, 0, 0, 0, 0)'));
  } finally {
    await adapter.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('replay without a state probe never claims verified reproduction', { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'glitchhunter-unverified-'));
  const server = await serveDirectory(new URL('../third_party/2048', import.meta.url).pathname);
  const adapter = new BrowserAdapter();
  try {
    const directory = join(root, 'episode');
    let calls = 0;
    const summary = await runEpisode({ adapter, directory, maxSteps: 100, maxTicks: 2, config: { url: server.url, hz: 60, viewport: { width: 800, height: 900 }, keys: ['ArrowLeft'] }, policy: async () => { calls++; return { held: [], ticks: 1 }; } });
    assert.equal(calls, 2);
    assert.equal(summary.reason, 'tick-budget');
    const result = await replayEpisode({ adapter, directory });
    assert.equal(result.verified, false);
    assert.equal(result.reason, 'inputs-replayed-without-state-verification');
  } finally {
    await adapter.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
