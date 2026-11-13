import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createImageGuard } from '../src/dsh-image-guard.mjs';
import { parseKeyDecision, parseActionDecision, runDshTurn, createDshTapPolicy, createDshActionPolicy } from '../src/dsh-policy.mjs';

const keys = ['ArrowLeft', 'ArrowRight'];

test('model output is data: unsupported keys, executable text and extra fields are refused', () => {
  assert.equal(parseKeyDecision('{"key":"ArrowLeft"}', keys).key, 'ArrowLeft');
  assert.equal(parseKeyDecision('```json\n{"key":"ArrowRight","note":"右侧有空位"}\n```', keys).key, 'ArrowRight');
  for (const text of ['process.exit()', '{"key":"F12"}', '{"key":"ArrowLeft","code":"anything"}', 'null']) assert.throws(() => parseKeyDecision(text, keys));
});

test('action decisions keep facts, hypotheses and failed attempts bounded and separate', () => {
  const controls = { keys, buttons: [], viewport: { width: 100, height: 100 } };
  const parsed = parseActionDecision(JSON.stringify({ action: { type: 'hold', held: ['ArrowLeft'], ticks: 3 }, memory: { facts: ['A visible tile'], hypotheses: ['Left may be blocked'], failedAttempts: [] } }), controls);
  assert.equal(parsed.memory.hypotheses[0], 'Left may be blocked');
  assert.throws(() => parseActionDecision('{"action":{"type":"tap","key":"F12"}}', controls));
  assert.throws(() => parseActionDecision(JSON.stringify({ action: { type: 'wait', ticks: 1 }, memory: { facts: ['x'.repeat(181)] } }), controls));
});

test('action policy retries invalid JSON, retains public feedback and memory, and honors model-call budget', async () => {
  const root = await mkdtemp(join(tmpdir(), 'glitchhunter-action-policy-'));
  let calls = 0;
  const controls = { keys, buttons: [], viewport: { width: 100, height: 100 } };
  try {
    const policy = await createDshActionPolicy({ directory: join(root, 'decisions'), controls, task: { description: 'Reach the visible target' }, maxModelCalls: 3, runTurn: async request => {
      assert.equal('verification' in request, false);
      calls++;
      if (calls === 1) return { final: 'bad json', audit: [] };
      if (calls === 2) {
        assert.ok(request.prompt.includes('previous response was not executed'));
        assert.ok(request.prompt.includes('Omit note and memory'));
        return { final: JSON.stringify({ action: { type: 'tap', key: 'ArrowLeft' }, memory: { facts: ['Two tiles'], hypotheses: ['Try right next'], failedAttempts: [] } }), audit: [] };
      }
      assert.ok(request.prompt.includes('Try right next'));
      assert.ok(request.prompt.includes('"visualChanged":false'));
      assert.ok(!request.prompt.includes('PRIVATE_PROBE'));
      return { final: '{"action":{"type":"tap","key":"ArrowRight"}}', audit: [] };
    } });
    const context = { observation: { image: { data: Buffer.from('image').toString('base64') } }, feedback: null, remaining: { steps: 10, ticks: 100, wallTimeMs: 5000 } };
    assert.equal((await policy(context)).key, 'ArrowLeft');
    assert.equal((await policy({ ...context, feedback: { status: 'executed', visualChanged: false, consecutiveNoProgress: 1 } })).key, 'ArrowRight');
    assert.equal(await policy(context), null);
    assert.equal(policy.stopReason(), 'model-call-budget');
    assert.equal(policy.describe().modelCalls, 3);
    assert.equal(policy.describe().decisions, 2);
    assert.equal(policy.describe().retries, 1);
    assert.equal(policy.describe().failedAttempts, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('exhausted model retries surface an error instead of returning a scripted fallback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'glitchhunter-retry-error-'));
  try {
    const policy = await createDshActionPolicy({ directory: join(root, 'decisions'), controls: { keys, buttons: [], viewport: { width: 100, height: 100 } }, task: { description: 'Play' }, maxAttempts: 2, runTurn: async () => ({ final: '{"key":"F12"}', audit: [] }) });
    await assert.rejects(policy({ observation: { image: { data: 'aW1hZ2U=' } }, remaining: { steps: 10, ticks: 100 } }), /failed after 2 attempts/);
    assert.equal(policy.describe().decisions, 0);
    assert.equal(policy.describe().modelCalls, 2);
    const errorRecord = JSON.parse(await readFile(join(root, 'decisions', '0001.attempt-2.error.json'), 'utf8'));
    assert.ok(errorRecord.message.includes('unsupported'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Harness execution guard only admits the current screenshot with a bounded read count', async () => {
  const root = await mkdtemp(join(tmpdir(), 'glitchhunter-guard-'));
  try {
    const screenshot = join(root, 'current.png');
    const other = join(root, 'other.png');
    await writeFile(screenshot, 'image');
    await writeFile(other, 'private');
    const guard = createImageGuard(screenshot);
    assert.ok(guard({ name: 'bash', arguments: { command: 'anything' } }));
    assert.ok(guard({ name: 'read_image', arguments: { file_path: other } }));
    assert.equal(guard({ name: 'read_image', arguments: { file_path: screenshot } }), undefined);
    assert.equal(guard({ name: 'read_image', arguments: { file_path: screenshot } }), undefined);
    assert.ok(guard({ name: 'read_image', arguments: { file_path: screenshot } }));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Harness protocol requires a successful image result and does not retain thinking events', async () => {
  const root = await mkdtemp(join(tmpdir(), 'glitchhunter-protocol-'));
  try {
    const fake = join(root, 'fake.mjs');
    const screenshot = join(root, 'current.png');
    await writeFile(fake, `
const image = process.env.GLITCHHUNTER_SCREENSHOT;
const events = [
 { type:'thinking', text:'internal text must not be retained' },
 { type:'tool_call', callId:'one', tool:'read_image', input:{file_path:image} },
 { type:'tool_result', callId:'one', status:'completed' },
 { type:'final', text:JSON.stringify({key:'ArrowLeft',note:'看见两个方块'}) }
];
for (const event of events) process.stdout.write(JSON.stringify(event)+'\\n');
process.stdin.resume();
`);
    const result = await runDshTurn({ binary: process.execPath, argsPrefix: [fake], patchPath: 'unused', screenshot, prompt: 'one move' });
    assert.equal(parseKeyDecision(result.final, keys).note, '看见两个方块');
    assert.equal(result.audit.some(event => event.type === 'thinking'), false);
    await writeFile(fake, `process.stdout.write(JSON.stringify({type:'final',text:'{"key":"ArrowLeft"}'})+'\\n'); process.stdin.resume();`);
    await assert.rejects(runDshTurn({ binary: process.execPath, argsPrefix: [fake], patchPath: 'unused', screenshot, prompt: 'one move' }), /did not successfully inspect/);
    await writeFile(fake, 'setInterval(() => {}, 1000); process.stdin.resume();');
    await assert.rejects(runDshTurn({ binary: process.execPath, argsPrefix: [fake], patchPath: 'unused', screenshot, prompt: 'one move', timeoutMs: 30 }), /timed out/);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('episode-limit')), 30);
    try {
      await assert.rejects(runDshTurn({ binary: process.execPath, argsPrefix: [fake], patchPath: 'unused', screenshot, prompt: 'one move', signal: controller.signal }), /episode-limit/);
    } finally { clearTimeout(timeout); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('tap policy makes one model decision and records press/release as separate atomic inputs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'glitchhunter-policy-'));
  let calls = 0;
  try {
    const directory = join(root, 'decisions');
    const policy = await createDshTapPolicy({ directory, keys, runTurn: async request => {
      calls++;
      assert.equal('verification' in request, false);
      assert.ok(!request.prompt.includes('PRIVATE_PROBE'));
      return { final: '{"key":"ArrowLeft"}', audit: [] };
    } });
    const input = { observation: { image: { data: Buffer.from('image').toString('base64') } }, remaining: { steps: 2, ticks: 18 }, feedback: null };
    assert.deepEqual(await policy(input), { held: ['ArrowLeft'], ticks: 6 });
    assert.deepEqual(await policy({ ...input, remaining: { steps: 1, ticks: 12 } }), { held: [], ticks: 12 });
    assert.equal(calls, 1);
    assert.equal((JSON.parse(await readFile(join(directory, '0001.json'), 'utf8'))).decision.key, 'ArrowLeft');
    assert.equal(await policy({ ...input, remaining: { steps: 1, ticks: 1 } }), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});
