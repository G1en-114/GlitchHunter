import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { compileAction } from './actions.mjs';

/** Per-invocation overlay: reuse existing account login without changing Web settings. */
export function makeDshPatch({ provider, model, reasoningEffort }) {
  const disabled = [
    'tool-plugin-manager', 'tool-working-directory', 'tool-bash', 'tool-pwsh',
    'tool-jobs', 'tool-fs-search', 'agent-instructions', 'tool-skill',
    'tool-subagent-control', 'tool-subagent-list-agents', 'tool-subagent',
    'tool-subagent-fork', 'tool-workflow', 'tool-todo', 'tool-goal', 'tool-web',
    'mcp-resources', 'session-title-llm', 'otel', 'session-telemetry-otel'
  ];
  return [
    ...disabled.map(id => ({ id, disabled: true })),
    ...['credentials', 'authorization', 'deepseek-account'].map(id => ({ id, disabled: false })),
    { id: 'agent-default-model', config: { provider, model, reasoningEffort } },
    { id: 'tools', config: { mode: 'native' } },
    { id: 'tool-fs', config: { read: false, readImage: true, write: false, edit: false } },
    { insert: [{ id: 'glitchhunter-image-guard', name: new URL('./dsh-image-guard.mjs', import.meta.url).pathname }] }
  ];
}

/** Consume only committed final output and operational audit events, never thinking. */
export async function runDshTurn({ binary = 'dsh', argsPrefix = [], patchPath, screenshot, prompt, cwd = process.cwd(), timeoutMs = 90000, signal }) {
  if (signal?.aborted) throw signal.reason;
  return new Promise((accept, reject) => {
    const child = spawn(binary, [...argsPrefix, '--profile', 'headless', '--patch', patchPath, '--json'], {
      cwd, env: { ...process.env, GLITCHHUNTER_SCREENSHOT: screenshot },
      stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32'
    });
    const audit = [];
    const calls = new Map();
    let line = '';
    let final;
    let sawImage = false;
    let bytes = 0;
    let failure;
    let diagnostic = '';
    const decoder = new StringDecoder('utf8');
    let killTimer;
    const signalProcess = signal => {
      try { if (process.platform !== 'win32') process.kill(-child.pid, signal); else child.kill(signal); } catch { /* already stopped */ }
    };
    const terminate = () => {
      signalProcess('SIGTERM');
      killTimer ??= setTimeout(() => signalProcess('SIGKILL'), 3000);
    };
    const timer = setTimeout(() => { failure = Object.assign(new Error('DeepSeek Harness decision timed out'), { code: 'MODEL_TIMEOUT' }); terminate(); }, timeoutMs);
    const abort = () => { failure = signal.reason; terminate(); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const consume = text => {
      if (!text.trim()) return;
      let event;
      try { event = JSON.parse(text); } catch { failure = new Error('Invalid Harness JSON event'); terminate(); return; }
      if (event.type === 'tool_call') {
        calls.set(event.callId, event);
        audit.push({ type: 'tool_call', tool: event.tool });
      } else if (event.type === 'tool_result') {
        const call = calls.get(event.callId);
        if (call?.tool === 'read_image' && resolve(call.input?.file_path ?? '') === screenshot && event.status === 'completed') sawImage = true;
        audit.push({ type: 'tool_result', tool: call?.tool ?? 'unknown', status: event.status });
      } else if (event.type === 'session') audit.push({ type: 'session', sessionId: event.sessionId });
      else if (event.type === 'status' && event.phase === 'turn_end') audit.push({ type: 'turn_end', reason: event.reason });
      else if (event.type === 'final') final = event.text;
      else if (event.type === 'error') audit.push({ type: 'error', message: String(event.message ?? '').slice(0, 1000) });
    };
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) { failure = new Error('Harness output budget exceeded'); terminate(); return; }
      line += decoder.write(chunk);
      let newline;
      while ((newline = line.indexOf('\n')) >= 0) { consume(line.slice(0, newline)); line = line.slice(newline + 1); }
    });
    // Diagnostics stay in memory. No credential files or reasoning streams are copied to run artifacts.
    child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk.toString('utf8')).slice(-8000); });
    child.stdin.on('error', () => {});
    child.once('error', error => { clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', abort); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
      line += decoder.end();
      if (line) consume(line);
      if (failure) { failure.audit = audit; reject(failure); return; }
      if (code !== 0) {
        const error = new Error(`DeepSeek Harness exited with code ${code}`);
        error.audit = audit;
        // Caller may inspect this in memory for startup diagnostics; not logged automatically.
        error.diagnostic = diagnostic;
        reject(error); return;
      }
      if (!sawImage) { reject(Object.assign(new Error('Harness did not successfully inspect the current screenshot'), { code: 'IMAGE_NOT_READ', audit })); return; }
      if (typeof final !== 'string') { reject(Object.assign(new Error('Harness did not return a final answer'), { code: 'MISSING_FINAL', audit })); return; }
      accept({ final, audit });
    });
    child.stdin.end(prompt);
  });
}

export function parseKeyDecision(text, keys) {
  const trimmed = text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, '$1');
  const decision = JSON.parse(trimmed);
  if (!decision || Array.isArray(decision) || typeof decision !== 'object' || Object.keys(decision).some(key => !['key', 'note'].includes(key))) throw new Error('Expected a key decision object');
  if (!keys.includes(decision.key)) throw new Error('Model selected an unsupported key');
  if (decision.note !== undefined && (typeof decision.note !== 'string' || decision.note.length > 500)) throw new Error('Invalid observation note');
  return decision;
}

export function parseActionDecision(text, controls) {
  const trimmed = text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, '$1');
  const value = JSON.parse(trimmed);
  if (value?.key !== undefined) {
    const legacy = parseKeyDecision(text, controls.keys);
    return { action: { type: 'tap', key: legacy.key }, ...(legacy.note ? { note: legacy.note } : {}) };
  }
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).some(key => !['action', 'note', 'memory'].includes(key))) throw new Error('Expected action, optional note and optional memory');
  if (value.action?.type === 'stop') {
    if (Object.keys(value.action).some(key => !['type', 'reason'].includes(key)) || typeof value.action.reason !== 'string' || value.action.reason.length > 180) throw new Error('Invalid stop action');
  } else compileAction(value.action, controls);
  if (value.note !== undefined && (typeof value.note !== 'string' || value.note.length > 500)) throw new Error('Invalid visible observation note');
  if (value.memory !== undefined) {
    if (!value.memory || typeof value.memory !== 'object' || Array.isArray(value.memory) || Object.keys(value.memory).some(key => !['facts', 'hypotheses', 'failedAttempts'].includes(key))) throw new Error('Invalid memory fields');
    for (const entries of Object.values(value.memory)) if (!Array.isArray(entries) || entries.length > 4 || entries.some(entry => typeof entry !== 'string' || entry.length > 180)) throw new Error('Memory must contain bounded short text lists');
  }
  return value;
}

/** 通用截图策略：短期记忆、失败反馈、限次重试与模型调用预算。 */
export async function createDshActionPolicy({ directory, controls, task, provider = 'deepseek-account', model = 'deepseek-flash', reasoningEffort = 'high', timeoutMs = 60000, maxModelCalls = 20, maxAttempts = 2, binary = 'dsh', runTurn = runDshTurn }) {
  for (const budget of [timeoutMs, maxModelCalls, maxAttempts]) if (!Number.isInteger(budget) || budget < 1) throw new Error('Invalid model budget');
  const decisions = resolve(directory);
  await mkdir(decisions, { recursive: false });
  const patchPath = join(decisions, 'harness.patch.yml');
  await writeFile(patchPath, JSON.stringify(makeDshPatch({ provider, model, reasoningEffort }), null, 2));
  const history = [];
  let memory = { facts: [], hypotheses: [], failedAttempts: [] };
  let modelCalls = 0, acceptedDecisions = 0, retries = 0, failedAttempts = 0, modelTimeMs = 0;
  let stopReason = 'policy-stop';
  let activeDecision = null;
  const decide = async ({ observation, feedback, remaining, signal }) => {
    if (history.length && feedback) history.at(-1).feedback = { status: feedback.status, visualChanged: feedback.visualChanged, consecutiveNoProgress: feedback.consecutiveNoProgress, public: feedback.public, message: feedback.message };
    if (modelCalls >= maxModelCalls) { stopReason = 'model-call-budget'; return null; }
    if (remaining.steps < 1 || remaining.ticks < 1) { stopReason = 'input-budget'; return null; }
    const screenshot = join(decisions, `${String(acceptedDecisions + 1).padStart(4, '0')}.png`);
    await writeFile(screenshot, Buffer.from(observation.image.data, 'base64'));
    let previousError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (signal?.aborted) throw signal.reason;
      if (modelCalls >= maxModelCalls) { stopReason = 'model-call-budget'; return null; }
      const basename = `${String(acceptedDecisions + 1).padStart(4, '0')}.attempt-${attempt}`;
      const prompt = previousError ? [
        `Task: ${task.description}`,
        `Read ${screenshot} with read_image first. Your previous response was not executed because: ${previousError}.`,
        `Allowed keys: ${JSON.stringify(controls.keys)}. Public feedback: ${JSON.stringify(feedback)}.`,
        'This is a format-repair attempt. Return exactly one minimal JSON object containing only action. Omit note and memory. No markdown, explanations, extra braces or second object.',
        'Example shape: {"action":{"type":"tap","key":"ArrowLeft"}}. Select the key from the actual screenshot.'
      ].join('\n') : [
        `Task: ${task.description}`,
        `Read the current screenshot at ${screenshot} with read_image before deciding.`,
        `Controls: ${JSON.stringify(controls)}`,
        'Choose one action: tap {type:"tap",key,ticks?:6,settleTicks?:12}; hold {type:"hold",held:[keys],buttons?:[],ticks}; release {type:"release",ticks?:1}; wait {type:"wait",ticks}; stop {type:"stop",reason}.',
        'tap presses and releases the key. hold sets the complete held state; repeating the same held key does not generate new keydown events. wait releases inputs. ticks are driver time slices, not guaranteed physics frames.',
        `Remaining input/time budget: ${JSON.stringify(remaining)}`,
        `Public HUD: ${JSON.stringify(observation.public ?? null)}`,
        `Previous execution feedback: ${JSON.stringify(feedback)}`,
        `Recent actions and observed results: ${JSON.stringify(history.slice(-6))}`,
        `Your prior self-reported memory (not independent verification): ${JSON.stringify(memory)}`,
        'If a prior action had no visible effect, reconsider the control or choose a different action. No hidden board, oracle result, or game variables are supplied.',
        'Return exactly one JSON object: {"action":{"type":"tap","key":"ArrowLeft"},"note":"brief visible fact","memory":{"facts":[],"hypotheses":[],"failedAttempts":[]}}. Note and memory are optional. Prefer at most two short entries per memory list. Separate observed facts, uncertain hypotheses and failed experiments. Do not output a reasoning transcript, markdown or trailing text. Requesting stop does not certify success.'
      ].filter(Boolean).join('\n');
      const started = performance.now();
      modelCalls++;
      if (attempt > 1) retries++;
      let result;
      try {
        result = await runTurn({ binary, patchPath, screenshot, prompt, signal, timeoutMs: Math.max(1, Math.min(timeoutMs, Math.floor(remaining.wallTimeMs ?? timeoutMs))) });
        const decision = parseActionDecision(result.final, controls);
        const durationMs = Math.round(performance.now() - started);
        await writeFile(join(decisions, `${basename}.json`), JSON.stringify({ provider, model, reasoningEffort, durationMs, decision, audit: result.audit }, null, 2));
        modelTimeMs += durationMs;
        acceptedDecisions++;
        if (decision.memory) memory = { ...memory, ...decision.memory };
        history.push({ action: decision.action, note: decision.note ?? '' });
        if (history.length > 6) history.shift();
        if (decision.action.type === 'stop') { stopReason = 'model-requested-stop'; return null; }
        return decision.action;
      } catch (error) {
        const durationMs = Math.round(performance.now() - started);
        modelTimeMs += durationMs;
        failedAttempts++;
        await writeFile(join(decisions, `${basename}.error.json`), JSON.stringify({ provider, model, durationMs, message: error.message, code: error.code ?? 'INVALID_DECISION', ...(result?.final ? { rejectedFinal: result.final.slice(0, 4096) } : {}), audit: error.audit ?? result?.audit ?? [] }, null, 2));
        if (signal?.aborted) throw signal.reason;
        previousError = error.message.slice(0, 300);
        if (attempt === maxAttempts) throw Object.assign(new Error(`Model decision failed after ${attempt} attempts: ${previousError}`), { code: 'MODEL_ATTEMPTS_EXHAUSTED' });
      }
    }
  };
  const policy = args => { activeDecision = decide(args); return activeDecision; };
  policy.settle = async () => { try { await activeDecision; } catch { /* 原错误已由运行器记录 */ } };
  policy.stopReason = () => stopReason;
  policy.describe = () => ({ provider, model, reasoningEffort, decisions: acceptedDecisions, modelCalls, callUnit: 'harness-invocation', retries, failedAttempts, modelTimeMs, budget: { maxModelCalls, maxAttempts, decisionTimeoutMs: timeoutMs }, observationMode: 'screenshot-and-public-hud', inputMode: 'compiled-player-actions' });
  return policy;
}

/** A tap macro is two recorded inputs: model-selected press, deterministic release. */
export async function createDshTapPolicy({ directory, keys, provider = 'deepseek-account', model = 'deepseek-flash', reasoningEffort = 'high', timeoutMs = 90000, binary = 'dsh', runTurn = runDshTurn }) {
  const decisions = resolve(directory);
  await mkdir(decisions, { recursive: false });
  const patchPath = join(decisions, 'harness.patch.yml');
  await writeFile(patchPath, JSON.stringify(makeDshPatch({ provider, model, reasoningEffort }), null, 2));
  const history = [];
  let releasePending = false;
  let count = 0;
  const policy = async ({ observation, feedback, remaining, signal }) => {
    if (releasePending) { releasePending = false; return { held: [], ticks: Math.min(12, remaining.ticks) }; }
    // Reserve enough time/steps for both the press and release.
    if (remaining.steps < 2 || remaining.ticks < 2) return null;
    count++;
    const basename = String(count).padStart(4, '0');
    const screenshot = join(decisions, `${basename}.png`);
    await writeFile(screenshot, Buffer.from(observation.image.data, 'base64'));
    const prompt = `Play one move of 2048. Read the screenshot at ${screenshot} with read_image first. Choose an arrow key using the visible board. Try to merge tiles and keep space available. No board state or hidden game variables are provided.\nAllowed keys: ${JSON.stringify(keys)}\nRecent selected moves: ${JSON.stringify(history.slice(-6))}\nPublic execution feedback: ${JSON.stringify(feedback)}\nYour key will be tapped and released automatically, then a new screenshot will be taken. Return only JSON: {"key":"ArrowLeft","note":"brief visible observation"}. The note is optional; do not include a reasoning transcript.`;
    const started = Date.now();
    let result;
    try {
      result = await runTurn({ binary, patchPath, screenshot, prompt, signal, timeoutMs: Math.max(1, Math.min(timeoutMs, Math.floor(remaining.wallTimeMs ?? timeoutMs))) });
      const decision = parseKeyDecision(result.final, keys);
      await writeFile(join(decisions, `${basename}.json`), JSON.stringify({ provider, model, reasoningEffort, durationMs: Date.now() - started, decision, audit: result.audit }, null, 2));
      history.push(decision.key);
      releasePending = true;
      return { held: [decision.key], ticks: Math.min(6, remaining.ticks - 1) };
    } catch (error) {
      await writeFile(join(decisions, `${basename}.error.json`), JSON.stringify({ provider, model, durationMs: Date.now() - started, message: error.message, audit: error.audit ?? result?.audit ?? [] }, null, 2));
      throw error;
    }
  };
  policy.describe = () => ({ provider, model, reasoningEffort, decisions: count, observationMode: 'screenshot-only', inputMode: 'tap-macro' });
  return policy;
}
