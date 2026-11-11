import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

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
export async function runDshTurn({ binary = 'dsh', argsPrefix = [], patchPath, screenshot, prompt, cwd = process.cwd(), timeoutMs = 90000 }) {
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
    const timer = setTimeout(() => { failure = new Error('DeepSeek Harness decision timed out'); terminate(); }, timeoutMs);
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
    child.once('error', error => { clearTimeout(timer); clearTimeout(killTimer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      clearTimeout(killTimer);
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
      if (!sawImage) { reject(new Error('Harness did not successfully inspect the current screenshot')); return; }
      if (typeof final !== 'string') { reject(new Error('Harness did not return a final answer')); return; }
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

/** A tap macro is two recorded inputs: model-selected press, deterministic release. */
export async function createDshTapPolicy({ directory, keys, provider = 'deepseek-account', model = 'deepseek-flash', reasoningEffort = 'high', timeoutMs = 90000, binary = 'dsh', runTurn = runDshTurn }) {
  const decisions = resolve(directory);
  await mkdir(decisions, { recursive: false });
  const patchPath = join(decisions, 'harness.patch.yml');
  await writeFile(patchPath, JSON.stringify(makeDshPatch({ provider, model, reasoningEffort }), null, 2));
  const history = [];
  let releasePending = false;
  let count = 0;
  const policy = async ({ observation, feedback, remaining }) => {
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
      result = await runTurn({ binary, patchPath, screenshot, prompt, timeoutMs });
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
