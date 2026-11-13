import { chromium } from 'playwright';
import { validateInput } from './input.mjs';

/** Trusted host-side adapter. The policy receives observations, never this object. */
export class BrowserAdapter {
  constructor({ executablePath = process.env.CHROMIUM_PATH, inspect = null, observePublic = null, headless = true } = {}) {
    this.options = { executablePath, headless };
    this.inspect = inspect;
    this.observePublic = observePublic;
    this.held = new Set();
    this.buttons = new Set();
  }

  async reset(config) {
    if (!Number.isInteger(config.hz) || config.hz < 1 || config.hz > 240) throw new Error('Invalid simulation frequency');
    if (config.seed !== undefined && (!Number.isInteger(config.seed) || config.seed < 0 || config.seed > 0xffffffff)) throw new Error('Seed must be uint32');
    if (config.seed !== undefined && !config.seededHarness) throw new Error('PRNG replacement requires explicit seededHarness mode');
    if (config.seededHarness && config.seed === undefined) throw new Error('Seeded harness mode requires a seed');
    if (!['allow', 'disabled'].includes(config.screenshotAnimations ?? 'allow')) throw new Error('Invalid screenshot animation mode');
    if (!this.browser) this.browser = await chromium.launch(this.options);
    if (this.context) await this.context.close();
    this.config = structuredClone(config);
    this.context = await this.browser.newContext({ viewport: config.viewport, locale: 'en-US', timezoneId: 'UTC', serviceWorkers: 'block', reducedMotion: 'reduce' });
    if (config.seededHarness && config.seed !== undefined) {
      // Explicit test instrumentation: a fresh context gets the same PRNG stream.
      // This is not a claim that arbitrary games become deterministic.
      await this.context.addInitScript(({ seed }) => {
        let state = seed >>> 0;
        Math.random = () => {
          state = (state + 0x6d2b79f5) | 0;
          let t = Math.imul(state ^ (state >>> 15), 1 | state);
          t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
      }, { seed: config.seed });
    }
    this.page = await this.context.newPage();
    this.errors = [];
    this.page.on('pageerror', error => this.errors.push({ name: error.name, message: error.message }));
    await this.page.clock.install({ time: new Date(0) });
    await this.page.clock.pauseAt(new Date(0));
    await this.page.goto(config.url, { waitUntil: 'load', timeout: 15000 });
    await this.page.bringToFront();
    this.held.clear();
    this.buttons.clear();
    this.tick = 0;
    this.controls = { keys: [...config.keys], buttons: [...(config.buttons ?? ['left', 'right'])], viewport: config.viewport };
    // A fixed bootstrap interval lets initial render callbacks finish.
    await this.page.clock.runFor(100);
    return this.capture();
  }

  async step(value) {
    const input = validateInput(value, this.controls);
    const wantedKeys = new Set(input.held);
    const wantedButtons = new Set(input.buttons);
    for (const key of [...this.held]) if (!wantedKeys.has(key)) { await this.page.keyboard.up(key); this.held.delete(key); }
    for (const button of [...this.buttons]) if (!wantedButtons.has(button)) { await this.page.mouse.up({ button }); this.buttons.delete(button); }
    if (input.pointer) await this.page.mouse.move(input.pointer.x, input.pointer.y);
    for (const key of wantedKeys) if (!this.held.has(key)) { await this.page.keyboard.down(key); this.held.add(key); }
    for (const button of wantedButtons) if (!this.buttons.has(button)) { await this.page.mouse.down({ button }); this.buttons.add(button); }
    // ticks are harness time slices, not a guarantee of engine physics steps.
    const startMs = Math.floor(this.tick * 1000 / this.config.hz);
    this.tick += input.ticks;
    const endMs = Math.floor(this.tick * 1000 / this.config.hz);
    await this.page.clock.runFor(endMs - startMs);
    return this.capture();
  }

  async capture() {
    const image = await this.page.screenshot({ type: 'png', animations: this.config.screenshotAnimations ?? 'allow', timeout: 10000 });
    const state = this.inspect ? await this.inspect(this.page) : null;
    const visible = this.observePublic ? await this.observePublic(this.page) : null;
    return {
      observation: {
        tick: this.tick,
        viewport: structuredClone(this.config.viewport),
        held: [...this.held],
        buttons: [...this.buttons],
        ...(visible ? { public: visible.public } : {}),
        image: { mimeType: 'image/png', data: image.toString('base64') }
      },
      verification: { available: Boolean(this.inspect), state, errors: structuredClone(this.errors) },
      progress: visible ? { key: visible.progressKey, source: 'visible-game-ui' } : null
    };
  }

  // 结束时仅释放输入，不推进模拟时间；仍由运行器记录供重放。
  async releaseAll() {
    for (const key of [...this.held]) { await this.page.keyboard.up(key); this.held.delete(key); }
    for (const button of [...this.buttons]) { await this.page.mouse.up({ button }); this.buttons.delete(button); }
    return this.capture();
  }

  inputState() { return { held: [...this.held], buttons: [...this.buttons] }; }

  async describe() {
    return { driver: 'playwright', browser: this.browser.version(), clock: 'browser-virtual-time', screenshotAnimations: this.config.screenshotAnimations ?? 'allow', physicsStepGuaranteed: false, randomControl: this.config.seededHarness ? 'Math.random test override' : 'uncontrolled' };
  }

  async close() {
    try {
      if (this.page && !this.page.isClosed()) {
        for (const key of this.held) await this.page.keyboard.up(key);
        for (const button of this.buttons) await this.page.mouse.up({ button });
      }
    } finally {
      await this.browser?.close();
      this.browser = null;
      this.context = null;
    }
  }
}
