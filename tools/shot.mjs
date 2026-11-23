/*
 * Headless screenshot + diagnostics harness (development only).
 * Usage: node tools/shot.mjs "http://127.0.0.1:8123/?v=11" out.png [waitMs]
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const url = process.argv[2] || "http://127.0.0.1:8123/";
const out = process.argv[3] || join(tmpdir(), "aurora-shot.png");
const waitMs = Number(process.argv[4] || 4000);
const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const port = 9341;
const size = process.env.SHOT_SIZE || "1200,750";
const profile = join(tmpdir(), "aurora-cdp-" + Date.now());

mkdirSync(profile, { recursive: true });
const chrome = spawn(chromePath, [
  "--headless=new",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-dev-shm-usage",
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

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

let ws;
try {
  const page = await targets();
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  const cdp = new CDP(ws);
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  await cdp.send("Page.enable");

  if (process.env.SHOT_EMULATE) {
    const [w, h] = process.env.SHOT_EMULATE.split("x").map(Number);
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: w,
      height: h,
      deviceScaleFactor: Number(process.env.SHOT_DPR || 1),
      mobile: true,
    });
    await cdp.send("Page.reload", { ignoreCache: true });
    await sleep(600);
  }

  let ready = false;
  for (let i = 0; i < 180; i++) {
    const r = await cdp.send("Runtime.evaluate", {
      expression: "!!(window.__aurora && window.__aurora.renderer)",
      returnByValue: true,
    });
    if (r.result && r.result.value === true) { ready = true; break; }
    await sleep(1000);
  }
  console.log("ready:", ready);
  await sleep(waitMs);

  if (process.env.SHOT_EVAL) {
    await cdp.send("Runtime.evaluate", {
      expression: process.env.SHOT_EVAL,
      returnByValue: true,
      awaitPromise: true,
    });
    await sleep(Number(process.env.SHOT_EVAL_WAIT || 0));
  }

  const info = await cdp.send("Runtime.evaluate", {
    expression: `JSON.stringify({
      title: document.title,
      fps: (document.getElementById("fps-label")||{}).textContent,
      res: (document.getElementById("res-label")||{}).textContent,
      phase: (document.getElementById("phase-label")||{}).textContent,
      loading: (document.getElementById("loading")||{}).style.display,
      size: [innerWidth, innerHeight],
      debug: window.__aurora ? window.__aurora.state.debug : null,
      auroraScale: window.__aurora ? window.__aurora.renderer.auroraScale : null
    })`,
    returnByValue: true,
  });
  console.log("state:", info.result.value);

  let base64 = "";
  if (process.env.SHOT_PAGE) {
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    base64 = shot.data || "";
  } else {
    const dataUrl = await cdp.send("Runtime.evaluate", {
      expression: "document.getElementById('stage').toDataURL('image/png')",
      returnByValue: true,
    });
    base64 = (dataUrl.result.value || "").split(",")[1] || "";
  }
  if (base64) {
    writeFileSync(out, Buffer.from(base64, "base64"));
    console.log("saved:", out, base64.length);
  } else {
    console.log("no canvas data");
  }

  const issues = cdp.events.filter((e) =>
    e.method === "Log.entryAdded" ||
    e.method === "Runtime.exceptionThrown" ||
    (e.method === "Runtime.consoleAPICalled" && e.params.type === "error")
  );
  if (issues.length) {
    console.log("--- console ---");
    for (const e of issues.slice(-20)) {
      if (e.method === "Log.entryAdded") console.log("LOG", e.params.entry.level, e.params.entry.text);
      if (e.method === "Runtime.exceptionThrown") console.log("EXC", e.params.exceptionDetails.text, e.params.exceptionDetails.exception?.description);
      if (e.method === "Runtime.consoleAPICalled") console.log("ERR", e.params.args.map((a) => a.value || a.description).join(" "));
    }
  } else {
    console.log("--- console clean ---");
  }
} finally {
  try { ws && ws.close(); } catch (_) {}
  try { chrome.kill(); } catch (_) {}
  await sleep(400);
  try { rmSync(profile, { recursive: true, force: true }); } catch (_) {}
}
process.exit(0);
