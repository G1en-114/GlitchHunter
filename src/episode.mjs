import { mkdir, writeFile, appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { validateInput } from './input.mjs';

const digest = data => createHash('sha256').update(data).digest('hex');
const canonical = value => JSON.stringify(value, function (_key, item) {
  if (item && typeof item === 'object' && !Array.isArray(item)) return Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]));
  return item;
});

async function storeCapture(directory, index, capture) {
  const { image, ...observation } = capture.observation;
  const filename = `${String(index).padStart(5, '0')}.png`;
  const bytes = Buffer.from(image.data, 'base64');
  await writeFile(join(directory, filename), bytes);
  return { observation: { ...observation, image: filename, imageHash: digest(bytes) }, verification: capture.verification };
}

/** One policy, bounded actions. Private verifier state is never passed to policy. */
export async function runEpisode({ adapter, policy, config, directory, maxSteps = 100, maxTicks = 6000, check = () => [], policyLabel = 'custom-policy' }) {
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || !Number.isInteger(maxTicks) || maxTicks < 1) throw new Error('Invalid episode budget');
  // Refuse to overwrite evidence from an existing run.
  await mkdir(directory, { recursive: false });
  let capture = await adapter.reset(config);
  const controls = { keys: config.keys, buttons: config.buttons ?? ['left', 'right'], viewport: config.viewport };
  const initial = await storeCapture(directory, 0, capture);
  await writeFile(join(directory, 'meta.json'), JSON.stringify({ schemaVersion: 1, config, driver: await adapter.describe(), budget: { maxSteps, maxTicks }, initial }, null, 2));
  const findings = [];
  let steps = 0;
  let ticks = 0;
  let reason = 'step-budget';
  let feedback = null;
  for (; steps < maxSteps; steps++) {
    if (ticks >= maxTicks) { reason = 'tick-budget'; break; }
    const decision = await policy({ observation: structuredClone(capture.observation), feedback, remaining: { steps: maxSteps - steps, ticks: maxTicks - ticks } });
    if (decision === null) { reason = 'policy-stop'; break; }
    const input = validateInput(decision, controls, Math.min(240, maxTicks - ticks));
    const previous = capture;
    capture = await adapter.step(input);
    ticks += input.ticks;
    const detected = await check({ before: previous.verification, input, after: capture.verification });
    findings.push(...detected.map(finding => ({ step: steps + 1, ...finding })));
    const stored = await storeCapture(directory, steps + 1, capture);
    await appendFile(join(directory, 'trace.jsonl'), JSON.stringify({ step: steps + 1, input, ...stored, findings: detected }) + '\n');
    // Feedback contains only public execution information, not checker truth.
    feedback = { input, ticks, status: 'executed' };
  }
  const summary = { steps, ticks, reason, findings, policyLabel };
  await writeFile(join(directory, 'summary.json'), JSON.stringify(summary, null, 2));
  return summary;
}

/** Replay recorded inputs without a policy or model. Compare every trusted checkpoint. */
export async function replayEpisode({ adapter, directory, url, buildId }) {
  const meta = JSON.parse(await readFile(join(directory, 'meta.json'), 'utf8'));
  if (meta.schemaVersion !== 1) throw new Error('Unsupported trace schema');
  if (meta.config.buildId && meta.config.buildId !== buildId) return { verified: false, divergenceAt: 0, reason: 'build-missing-or-mismatched' };
  let text = '';
  try { text = await readFile(join(directory, 'trace.jsonl'), 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const records = text.trim() ? text.trim().split('\n').map(line => JSON.parse(line)) : [];
  const actual = await adapter.reset({ ...meta.config, ...(url ? { url } : {}) });
  const driver = await adapter.describe();
  if (canonical(driver) !== canonical(meta.driver)) return { verified: false, divergenceAt: 0, reason: 'driver-mismatch' };
  if (canonical(actual.verification) !== canonical(meta.initial.verification)) return { verified: false, divergenceAt: 0, reason: 'initial-state-mismatch' };
  let verifiable = actual.verification.available;
  for (const record of records) {
    const capture = await adapter.step(record.input);
    verifiable &&= capture.verification.available;
    if (canonical(capture.verification) !== canonical(record.verification)) return { verified: false, divergenceAt: record.step, reason: 'checkpoint-mismatch' };
  }
  return { verified: verifiable, steps: records.length, reason: verifiable ? 'all-inspected-checkpoints-match' : 'inputs-replayed-without-state-verification' };
}
