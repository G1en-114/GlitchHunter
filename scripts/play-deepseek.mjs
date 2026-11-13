import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { BrowserAdapter } from '../src/browser.mjs';
import { serveDirectory } from '../src/server.mjs';
import { inspect2048, observePublic2048, evaluate2048 } from '../src/inspect-2048.mjs';
import { runEpisode, replayEpisode } from '../src/episode.mjs';
import { fingerprintDirectory } from '../src/build.mjs';
import { createDshActionPolicy } from '../src/dsh-policy.mjs';

function integerEnv(name, fallback, minimum, maximum) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be ${minimum}..${maximum}`);
  return value;
}
const moves = integerEnv('GLITCHHUNTER_MOVES', 12, 1, 100);
const seconds = integerEnv('GLITCHHUNTER_SECONDS', 180, 1, 1800);
const modelCalls = integerEnv('GLITCHHUNTER_MODEL_CALLS', moves + 2, 1, 200);
const targetTile = integerEnv('GLITCHHUNTER_TARGET_TILE', 32, 4, 2048);
if ((targetTile & (targetTile - 1)) !== 0) throw new Error('Target tile must be a power of two');
const seeds = (process.env.GLITCHHUNTER_SEEDS ?? process.env.GLITCHHUNTER_SEED ?? '42').split(',').map(Number);
if (!seeds.length || seeds.length > 5 || seeds.some(seed => !Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) || new Set(seeds).size !== seeds.length) throw new Error('Specify 1..5 distinct uint32 seeds');
const fixture = new URL('../third_party/2048', import.meta.url).pathname;
const { buildId } = await fingerprintDirectory(fixture);
await mkdir('runs', { recursive: true });
const directory = resolve('runs', `deepseek-${Date.now()}`);
await mkdir(directory);
const keys = ['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown'];
const viewport = { width: 800, height: 900 };
const controls = { keys, buttons: [], viewport };
const task = { id: `2048-tile-${targetTile}`, description: `Play 2048 and create a tile of value ${targetTile}. Merge equal tiles and keep space available. Arrow keys are discrete moves: prefer tap rather than holding. If a move has no effect, try another direction. Stop if the visible game-over screen appears. Your claims are not the task verifier.` };
const server = await serveDirectory(fixture);
const adapter = new BrowserAdapter({ inspect: inspect2048, observePublic: observePublic2048 });
const results = [];
console.log(JSON.stringify({ directory, seeds, targetTile, maxActionsPerSeed: moves, wallSecondsPerSeed: seconds }));
try {
  for (const seed of seeds) {
    const runDirectory = join(directory, `seed-${seed}`);
    await mkdir(runDirectory);
    const policy = await createDshActionPolicy({ directory: join(runDirectory, 'decisions'), controls, task,
      binary: process.env.DSH_BINARY ?? 'dsh', provider: process.env.DSH_PLAYER_PROVIDER ?? 'deepseek-account',
      model: process.env.DSH_PLAYER_MODEL ?? 'deepseek-flash', reasoningEffort: process.env.DSH_PLAYER_EFFORT ?? 'high', maxModelCalls: modelCalls
    });
    const summary = await runEpisode({ adapter, policy, directory: join(runDirectory, 'episode'), task,
      config: { url: server.url, hz: 60, viewport, keys, buttons: [], seed, seededHarness: true, screenshotAnimations: 'disabled', gameId: '2048-upstream-local', buildId },
      maxSteps: moves * 3, maxActions: moves, maxTicks: moves * 240, maxDurationMs: seconds * 1000, stallLimit: 4,
      evaluate: capture => evaluate2048(capture, targetTile), policyLabel: 'deepseek-harness-action-player'
    });
    let replay;
    try { replay = await replayEpisode({ adapter, directory: join(runDirectory, 'episode'), buildId }); }
    catch (error) { replay = { verified: false, reason: 'replay-error', message: error.message }; }
    const result = { seed, ...policy.describe(), summary, replay };
    results.push(result);
    await writeFile(join(runDirectory, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    if (summary.status === 'error' || !replay.verified) { process.exitCode = 1; break; }
  }
} finally {
  await adapter.close();
  await server.close();
  await writeFile(join(directory, 'batch.json'), JSON.stringify({ date: new Date().toISOString(), task, buildId, requestedSeeds: seeds, results }, null, 2));
}
