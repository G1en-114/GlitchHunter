import { mkdir, writeFile, appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { compileAction } from './actions.mjs';

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
  return { observation: { ...observation, image: filename, imageHash: digest(bytes) }, verification: capture.verification, progress: capture.progress ?? null };
}

function progressKey(capture) {
  return capture.progress?.key ?? digest(capture.observation.image.data);
}

function waitForPolicy(policy, args, signal) {
  return new Promise((accept, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => policy(args)).then(accept, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** 单个策略循环：任务判定、公开反馈、动作预算和完整的失败证据。 */
export async function runEpisode({ adapter, policy, config, directory, maxSteps = 100, maxTicks = 6000, maxActions = maxSteps, maxDurationMs = 600000, stallLimit = 0, maxRejectedActions = 2, check = () => [], evaluate = () => ({ status: 'running' }), task = null, policyLabel = 'custom-policy' }) {
  for (const budget of [maxSteps, maxTicks, maxActions, maxDurationMs, maxRejectedActions]) if (!Number.isInteger(budget) || budget < 1) throw new Error('Invalid episode budget');
  if (!Number.isInteger(stallLimit) || stallLimit < 0) throw new Error('Invalid stall limit');
  await mkdir(directory, { recursive: false });
  const started = performance.now();
  const controller = new AbortController();
  const deadlineError = Object.assign(new Error('Episode wall time budget exhausted'), { code: 'WALL_TIME_BUDGET' });
  const timer = setTimeout(() => controller.abort(deadlineError), maxDurationMs);
  const controls = { keys: config.keys, buttons: config.buttons ?? ['left', 'right'], viewport: config.viewport };
  const findings = [];
  let capture;
  let steps = 0, ticks = 0, records = 0, actions = 0, policyCalls = 0, rejectedActions = 0;
  let noProgress = 0, changedActions = 0, noProgressActions = 0, maxNoProgress = 0;
  let status = 'budget-exhausted';
  let reason = 'step-budget';
  let outcome = { status: 'running' };
  let errorInfo = null;
  let feedback = null;
  const event = data => appendFile(join(directory, 'events.jsonl'), JSON.stringify(data) + '\n');
  const record = async data => {
    const stored = await storeCapture(directory, ++records, capture);
    await appendFile(join(directory, 'trace.jsonl'), JSON.stringify({ step: records, ...data, ...stored }) + '\n');
  };
  const adjudicate = async () => {
    outcome = await evaluate(capture);
    if (!['running', 'success', 'failure'].includes(outcome?.status)) throw new Error('Invalid task evaluator result');
    if (outcome.status !== 'running') { status = outcome.status; reason = outcome.reason ?? 'task-ended'; return true; }
    return false;
  };
  try {
    capture = await adapter.reset(config);
    const initial = await storeCapture(directory, 0, capture);
    await writeFile(join(directory, 'meta.json'), JSON.stringify({ schemaVersion: 2, config, task, driver: await adapter.describe(), budget: { maxSteps, maxTicks, maxActions, maxDurationMs, stallLimit, maxRejectedActions }, initial }, null, 2));
    if (!await adjudicate()) while (steps < maxSteps && actions < maxActions) {
      if (controller.signal.aborted) { reason = 'wall-time-budget'; break; }
      if (ticks >= maxTicks) { reason = 'tick-budget'; break; }
      const remaining = { steps: maxSteps - steps, ticks: maxTicks - ticks, wallTimeMs: Math.max(0, maxDurationMs - (performance.now() - started)) };
      policyCalls++;
      const decision = await waitForPolicy(policy, { observation: structuredClone(capture.observation), feedback: structuredClone(feedback), remaining, signal: controller.signal }, controller.signal);
      if (controller.signal.aborted) { reason = 'wall-time-budget'; break; }
      if (decision === null) {
        reason = policy.stopReason?.() ?? 'policy-stop';
        status = reason.endsWith('-budget') ? 'budget-exhausted' : 'policy-stopped';
        break;
      }
      let inputs;
      try { inputs = compileAction(decision, controls, capture.observation); }
      catch (error) {
        rejectedActions++;
        feedback = { status: 'rejected', message: error.message, consecutiveNoProgress: noProgress };
        await event({ type: 'action-rejected', policyCall: policyCalls, message: error.message });
        if (rejectedActions >= maxRejectedActions) { status = 'error'; reason = 'rejected-action-budget'; break; }
        continue;
      }
      const actionTicks = inputs.reduce((sum, input) => sum + input.ticks, 0);
      // 整个动作（包括松开）必须能放进预算，不静默截断。
      if (inputs.length > remaining.steps) { reason = 'step-budget'; break; }
      if (actionTicks > remaining.ticks) { reason = 'tick-budget'; break; }
      const beforeAction = capture;
      actions++;
      for (const [phase, input] of inputs.entries()) {
        const previous = capture;
        await event({ type: 'input-attempt', actionId: actions, phase, input });
        try { capture = await adapter.step(input); }
        catch (error) {
          await event({ type: 'input-failed', actionId: actions, phase, message: error.message, mayHaveApplied: true });
          throw error;
        }
        steps++;
        ticks += input.ticks;
        let detected = [];
        let checkError;
        try { detected = await check({ before: previous.verification, input, after: capture.verification }); }
        catch (error) { checkError = error; }
        findings.push(...detected.map(finding => ({ step: records + 1, ...finding })));
        await record({ actionId: actions, phase, input, findings: detected, ...(checkError ? { checkError: checkError.message } : {}) });
        if (checkError) throw checkError;
      }
      const changed = progressKey(beforeAction) !== progressKey(capture);
      if (changed) { changedActions++; noProgress = 0; }
      else { noProgressActions++; noProgress++; }
      maxNoProgress = Math.max(maxNoProgress, noProgress);
      // 只有可见反馈进策略；任务检查和内部格子数据不进入上下文。
      feedback = { status: 'executed', action: decision, visualChanged: changed, consecutiveNoProgress: noProgress, public: capture.observation.public ?? null, ticks };
      await event({ type: 'action-completed', actionId: actions, visualChanged: changed, consecutiveNoProgress: noProgress, public: capture.observation.public ?? null });
      if (await adjudicate()) break;
      if (controller.signal.aborted) { reason = 'wall-time-budget'; break; }
      if (stallLimit && noProgress >= stallLimit) { status = 'stalled'; reason = 'no-visible-progress'; break; }
    }
    if (status === 'budget-exhausted' && reason === 'step-budget' && actions >= maxActions && steps < maxSteps) reason = 'action-budget';
  } catch (error) {
    if (error.code === 'WALL_TIME_BUDGET' || controller.signal.aborted) { status = 'budget-exhausted'; reason = 'wall-time-budget'; }
    else { status = 'error'; reason = 'execution-error'; errorInfo = { code: error.code ?? 'EXECUTION_ERROR', message: error.message }; }
  } finally {
    clearTimeout(timer);
    if (controller.signal.aborted) await policy.settle?.();
    // 即使 hold 后因终局/预算停止，也释放按键并留下零时间清理记录。
    const inputState = adapter.inputState?.() ?? capture?.observation;
    if (capture && (inputState?.held?.length || inputState?.buttons?.length)) {
      try {
        if (!adapter.releaseAll) throw new Error('Adapter must support releaseAll for held-input cleanup');
        capture = await adapter.releaseAll();
        await record({ kind: 'release-all', input: null, findings: [] });
      } catch (error) { status = 'error'; reason = 'cleanup-error'; errorInfo = { code: 'CLEANUP_ERROR', message: error.message }; }
    }
  }
  const summary = {
    status, reason, steps, ticks, recordedSteps: records, cleanupSteps: records - steps,
    task, outcome, findings, policyLabel,
    metrics: { actions, policyCalls, rejectedActions, changedActions, noProgressActions, maxConsecutiveNoProgress: maxNoProgress, durationMs: Math.round(performance.now() - started), policy: policy.describe?.() ?? null },
    ...(errorInfo ? { error: errorInfo } : {})
  };
  await writeFile(join(directory, 'summary.json'), JSON.stringify(summary, null, 2));
  return summary;
}

/** Replay recorded inputs without a policy or model. Compare every trusted checkpoint. */
export async function replayEpisode({ adapter, directory, url, buildId }) {
  const meta = JSON.parse(await readFile(join(directory, 'meta.json'), 'utf8'));
  if (![1, 2].includes(meta.schemaVersion)) throw new Error('Unsupported trace schema');
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
    const capture = record.kind === 'release-all' ? await adapter.releaseAll() : await adapter.step(record.input);
    verifiable &&= capture.verification.available;
    if (canonical(capture.verification) !== canonical(record.verification)) return { verified: false, divergenceAt: record.step, reason: 'checkpoint-mismatch' };
  }
  return { verified: verifiable, steps: records.length, reason: verifiable ? 'all-inspected-checkpoints-match' : 'inputs-replayed-without-state-verification' };
}
