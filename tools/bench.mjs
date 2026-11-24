/*
 * Headless frame-time benchmark (development only).
 *
 * Usage:
 *   node tools/bench.mjs "http://127.0.0.1:8123/?capture=1" [quality] [frames]
 *
 * Prints the median, p95 and mean frame time in ms plus the effective
 * megapixels per frame.  Headless Chrome falls back to SwiftShader here, so
 * the absolute numbers are only a proxy for a real GPU; use them to compare
 * two builds at the same size and quality tier.
 */
import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const url = process.argv[2] || "http://127.0.0.1:8123/?capture=1";
const quality = process.argv[3] || "high";
const frames = Number(process.argv[4] || 120);
const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const port = 9342;
const size = process.env.SHOT_SIZE || "1280,800";
const profile = join(tmpdir(), "aurora-bench-" + Date.now());

mkdirSync(profile, { recursive: true });
const chrome = spawn(chromePath, [
  "--headless=new",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-dev-shm-usage",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--enable-unsafe-swiftshader",
  "--use-angle=swiftshader",
  "--hide-scrollbars",
  "--window-size=" + size,
  "--force-device-scale-factor=1",
  `--user-data-dir=${profile}`,
  `--remote-debugging-port=${port}`,
  url,
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === "page" && /^(https?|file):/.test(t.url));
      if (page) return page;
    } catch (_) {}
    await sleep(500);
  }
  throw new Error("No page target");
}

let ws;
try {
  const page = await targets();
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });

  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      pending.set(++id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  await send("Runtime.enable");
  await send("Page.enable");
  try { await send("Page.bringToFront"); } catch (_) {}

  for (let i = 0; i < 180; i++) {
    const r = await send("Runtime.evaluate", {
      expression: "!!(window.__aurora && window.__aurora.renderer)",
      returnByValue: true,
    });
    if (r.result && r.result.value === true) break;
    await sleep(1000);
  }

  const run = async (label, expression) => {
    const r = await Promise.race([
      send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      }),
      sleep(60000).then(() => ({ timeout: true })),
    ]);
    if (r.timeout) {
      console.log(label, "timed out");
      return null;
    }
    if (r.exceptionDetails) {
      console.log(label, "error", r.exceptionDetails.text);
      return null;
    }
    const value = r.result.value;
    if (!value) {
      console.log(label, "no result");
      return null;
    }
    return value;
  };

  const setup = await run("setup", `(() => {
    const c = window.__aurora.camera;
    c.setAuto(false);
    window.__aurora.params.autoQuality = false;
    window.__aurora.setQuality(${JSON.stringify(quality)});
    const gl = window.__aurora.renderer.gl;
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    return {
      renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "unknown",
      size: [gl.drawingBufferWidth, gl.drawingBufferHeight],
      auroraScale: window.__aurora.renderer.auroraScale,
    };
  })()`);

  console.log("renderer:", setup && setup.renderer);
  console.log("buffer:", setup && setup.size.join("x"), "auroraScale:", setup && setup.auroraScale);

  await sleep(1500);

  const layers = process.env.BENCH_LAYERS ? Number(process.env.BENCH_LAYERS) : 0;
  const result = await run("measure", `(async () => {
    const A = window.__aurora;
    const r = A.renderer;
    const gl = r.gl;
    const state = A.state;
    ${layers ? `state.layers = ${layers};` : ""}
    const px = new Uint8Array(4);
    r.render(state);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const times = [];
    const calls0 = r.drawCalls;
    for (let i = 0; i < ${frames}; i++) {
      const a = performance.now();
      r.render(state);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      times.push(performance.now() - a);
    }
    times.sort((a, b) => a - b);
    const at = (q) => times[Math.min(times.length - 1, Math.floor(q * times.length))];
    const sum = times.reduce((a, b) => a + b, 0);
    return {
      frames: times.length,
      drawCalls: r.drawCalls - calls0,
      median: +at(0.5).toFixed(2),
      p95: +at(0.95).toFixed(2),
      mean: +(sum / times.length).toFixed(2),
      min: +times[0].toFixed(2),
    };
  })()`);

  if (!result) process.exit(1);
  console.log("frames:", result.frames, "drawCalls:", result.drawCalls,
    layers ? "layers: " + layers : "",
    "median:", result.median + " ms",
    "p95:", result.p95 + " ms",
    "mean:", result.mean + " ms",
    "min:", result.min + " ms");
} finally {
  try { ws && ws.close(); } catch (_) {}
  try { chrome.kill(); } catch (_) {}
  await sleep(400);
  try { rmSync(profile, { recursive: true, force: true }); } catch (_) {}
}
process.exit(0);
