import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { BrowserAdapter } from '../src/browser.mjs';
import { serveDirectory } from '../src/server.mjs';
import { inspect2048 } from '../src/inspect-2048.mjs';
import { runEpisode, replayEpisode } from '../src/episode.mjs';
import { fingerprintDirectory } from '../src/build.mjs';

const fixture = new URL('../third_party/2048', import.meta.url).pathname;
const { buildId } = await fingerprintDirectory(fixture);
const server = await serveDirectory(fixture);
const adapter = new BrowserAdapter({ inspect: inspect2048 });
await mkdir('runs', { recursive: true });
const directory = resolve('runs', `2048-${Date.now()}`);
const keys = ['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown'];
let step = 0;
try {
  const summary = await runEpisode({
    adapter,
    directory,
    config: { url: server.url, hz: 60, viewport: { width: 800, height: 900 }, keys, seed: 42, seededHarness: true, screenshotAnimations: 'disabled', gameId: '2048-upstream-local', buildId },
    maxSteps: 24,
    policyLabel: 'scripted-input-baseline-no-model',
    // A transparent scripted baseline to validate infrastructure, not an AI player.
    policy: async () => {
      const held = step % 2 ? [] : [keys[Math.floor(step / 2) % keys.length]];
      step++;
      return { held, ticks: 12 };
    }
  });
  const replay = await replayEpisode({ adapter, directory, buildId });
  console.log(JSON.stringify({ directory, summary, replay }, null, 2));
  if (!replay.verified) process.exitCode = 1;
} finally {
  await adapter.close();
  await server.close();
}
