import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { BrowserAdapter } from '../src/browser.mjs';
import { serveDirectory } from '../src/server.mjs';
import { inspect2048 } from '../src/inspect-2048.mjs';
import { runEpisode, replayEpisode } from '../src/episode.mjs';
import { fingerprintDirectory } from '../src/build.mjs';
import { createDshTapPolicy } from '../src/dsh-policy.mjs';

const moves = Number(process.env.GLITCHHUNTER_MOVES ?? 4);
if (!Number.isInteger(moves) || moves < 1 || moves > 100) throw new Error('GLITCHHUNTER_MOVES must be 1..100');
const fixture = new URL('../third_party/2048', import.meta.url).pathname;
const { buildId } = await fingerprintDirectory(fixture);
await mkdir('runs', { recursive: true });
const directory = resolve('runs', `deepseek-${Date.now()}`);
await mkdir(directory);
const keys = ['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown'];
const policy = await createDshTapPolicy({
  directory: join(directory, 'decisions'), keys,
  binary: process.env.DSH_BINARY ?? 'dsh',
  provider: process.env.DSH_PLAYER_PROVIDER ?? 'deepseek-account',
  model: process.env.DSH_PLAYER_MODEL ?? 'deepseek-flash',
  reasoningEffort: process.env.DSH_PLAYER_EFFORT ?? 'high'
});
const server = await serveDirectory(fixture);
const adapter = new BrowserAdapter({ inspect: inspect2048 });
console.log(JSON.stringify({ directory, ...policy.describe(), requestedMoves: moves }));
try {
  const summary = await runEpisode({ adapter, policy, directory: join(directory, 'episode'),
    config: { url: server.url, hz: 60, viewport: { width: 800, height: 900 }, keys, seed: 42, seededHarness: true, screenshotAnimations: 'disabled', gameId: '2048-upstream-local', buildId },
    maxSteps: moves * 2, maxTicks: moves * 18, policyLabel: 'deepseek-harness-screenshot-player'
  });
  const replay = await replayEpisode({ adapter, directory: join(directory, 'episode'), buildId });
  const result = { ...policy.describe(), summary, replay };
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (!replay.verified) process.exitCode = 1;
} catch (error) {
  await writeFile(join(directory, 'failure.json'), JSON.stringify({ message: error.message, ...policy.describe() }, null, 2));
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await adapter.close();
  await server.close();
}
