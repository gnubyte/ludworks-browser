// GPU meter for "open GPU-heavy pages in a separate process" (src/main/separate.js). Counts the page's WebGL and
// WebGPU draw calls: many small GPU commands per second are what queues up on the GPU process's command thread
// and makes every other page of the browser stutter. A page that keeps up at least MIN_RATE draws a second for
// SAMPLES seconds in a row is reported once, and the counters are removed again. Measured at 144 Hz: Twitch,
// Google Maps at rest and video draw nothing, page backgrounds (Stripe, GitHub's globe) 150–3,000 draws a second,
// a three.js demo scene 11,000, a game renderer issuing 2,000 draws a frame 290,000.
//
// The counters are installed in the page's main world with contextBridge.executeInMainWorld (pages see native-looking
// functions and no new globals); the report goes back through the function handed in as an argument.

export function setupGpuMeter() {
  const { contextBridge, ipcRenderer } = require('electron');
  let sent = false;
  const report = (rate) => {
    if (sent) return;
    sent = true;
    ipcRenderer.send('content', 'gpu.heavy', { drawsPerSecond: Math.round(Number(rate)) || 0 });
  };
  if (typeof contextBridge.executeInMainWorld === 'function') contextBridge.executeInMainWorld({ func: installGpuMeter, args: [report] });
}

// ---------------------------------------------------------------------------------------------------
// Runs in the page's main world. Must be self-contained (it is serialised): no outer references.
// `opts` is for tests only.
export function installGpuMeter(report, opts) {
  const o = opts || {};
  const MIN_RATE = o.minRate || 20000; // draws a second
  const SAMPLES = o.samples || 10; // consecutive samples at or above MIN_RATE
  const INTERVAL = o.intervalMs || 1000;
  const IDLE_SAMPLES = 30; // samples without a draw before the timer stops (the next draw restarts it)
  const W = typeof window === 'object' ? window : globalThis;
  const NAMES = {
    WebGLRenderingContext: ['drawArrays', 'drawElements'],
    WebGL2RenderingContext: ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements'],
    ANGLEInstancedArrays: ['drawArraysInstancedANGLE', 'drawElementsInstancedANGLE'],
    WebGLMultiDraw: ['multiDrawArraysWEBGL', 'multiDrawElementsWEBGL', 'multiDrawArraysInstancedWEBGL', 'multiDrawElementsInstancedWEBGL'],
    GPURenderPassEncoder: ['draw', 'drawIndexed', 'drawIndirect', 'drawIndexedIndirect'],
    GPURenderBundleEncoder: ['draw', 'drawIndexed', 'drawIndirect', 'drawIndexedIndirect'],
  };
  let draws = 0;
  let timer = 0;
  let last = 0;
  let run = 0;
  let idle = 0;
  const saved = [];
  const tick = () => {
    const now = performance.now();
    // Hidden pages get their timers throttled: a rate per elapsed time, not per tick.
    const rate = (draws * 1000) / Math.max(1, now - last);
    last = now;
    idle = draws ? 0 : idle + 1;
    draws = 0;
    run = rate >= MIN_RATE ? run + 1 : 0;
    if (run >= SAMPLES) {
      restore();
      try {
        report(rate);
      } catch {
        /* the page went away */
      }
    } else if (idle >= IDLE_SAMPLES) {
      clearInterval(timer);
      timer = 0;
    }
  };
  const trap = {
    apply(target, self, args) {
      draws++;
      if (!timer) {
        last = performance.now();
        run = 0;
        idle = 0;
        timer = setInterval(tick, INTERVAL);
      }
      return Reflect.apply(target, self, args);
    },
  };
  function restore() {
    clearInterval(timer);
    timer = 0;
    for (const [proto, name, desc] of saved) {
      try {
        Object.defineProperty(proto, name, desc);
      } catch {
        /* leave it wrapped */
      }
    }
    saved.length = 0;
  }
  for (const [cls, names] of Object.entries(NAMES)) {
    const proto = W[cls] && W[cls].prototype;
    if (!proto) continue;
    for (const name of names) {
      const desc = Object.getOwnPropertyDescriptor(proto, name);
      if (!desc || typeof desc.value !== 'function' || !desc.configurable) continue;
      saved.push([proto, name, desc]);
      // a Proxy of the native function still prints "[native code]"
      Object.defineProperty(proto, name, { ...desc, value: new Proxy(desc.value, trap) });
    }
  }
}
