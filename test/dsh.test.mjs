import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createImageGuard } from '../src/dsh-image-guard.mjs';
import { parseKeyDecision, runDshTurn, createDshTapPolicy } from '../src/dsh-policy.mjs';

const keys = ['ArrowLeft', 'ArrowRight'];

test('model output is data: unsupported keys, executable text and extra fields are refused', () => {
  assert.equal(parseKeyDecision('{"key":"ArrowLeft"}', keys).key, 'ArrowLeft');
  assert.equal(parseKeyDecision('```json\n{"key":"ArrowRight","note":"右侧有空位"}\n```', keys).key, 'ArrowRight');
  for (const text of ['process.exit()', '{"key":"F12"}', '{"key":"ArrowLeft","code":"anything"}', 'null']) assert.throws(() => parseKeyDecision(text, keys));
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
