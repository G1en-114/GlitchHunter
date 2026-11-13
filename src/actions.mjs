import { validateInput } from './input.mjs';

function fields(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new Error('Unsupported action fields');
}

// 高层动作只展开为真实输入；不按游戏设计意图过滤玩家操作。
export function compileAction(action, controls, current = {}) {
  if (!action?.type) return [validateInput(action, controls)]; // v0.1 原子输入兼容
  if (action.type === 'tap') {
    fields(action, ['type', 'key', 'ticks', 'settleTicks']);
    if (!controls.keys.includes(action.key)) throw new Error('Unsupported tap key');
    const press = validateInput({ held: [action.key], ticks: action.ticks ?? 6 }, controls);
    const release = validateInput({ held: [], ticks: action.settleTicks ?? 12 }, controls);
    const prefix = current.held?.length || current.buttons?.length ? [{ held: [], buttons: [], ticks: 1 }] : [];
    return [...prefix, press, release];
  }
  if (action.type === 'hold') {
    fields(action, ['type', 'held', 'buttons', 'pointer', 'ticks']);
    const { type, ...input } = action;
    return [validateInput(input, controls)];
  }
  if (action.type === 'release' || action.type === 'wait') {
    fields(action, ['type', 'ticks']);
    return [validateInput({ held: [], ticks: action.ticks ?? (action.type === 'wait' ? 12 : 1) }, controls)];
  }
  throw new Error('Unsupported action type');
}
