/** Input describes the complete held state for the next bounded time slice. */
export function validateInput(value, controls, maxTicks = 240) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Input must be an object');
  const allowed = new Set(['held', 'buttons', 'pointer', 'ticks']);
  if (Object.keys(value).some(key => !allowed.has(key))) throw new Error('Unknown input field');
  if (!Number.isInteger(value.ticks) || value.ticks < 1 || value.ticks > maxTicks) throw new Error('Invalid tick budget');
  const held = value.held ?? [];
  const buttons = value.buttons ?? [];
  if (!Array.isArray(held) || new Set(held).size !== held.length || held.some(key => !controls.keys.includes(key))) throw new Error('Unsupported or duplicate key');
  if (!Array.isArray(buttons) || new Set(buttons).size !== buttons.length || buttons.some(button => !controls.buttons.includes(button))) throw new Error('Unsupported or duplicate button');
  let pointer;
  if (value.pointer !== undefined) {
    const { x, y } = value.pointer ?? {};
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= controls.viewport.width || y >= controls.viewport.height) throw new Error('Pointer outside viewport');
    pointer = { x, y };
  }
  return { held: [...held], buttons: [...buttons], ...(pointer ? { pointer } : {}), ticks: value.ticks };
}
