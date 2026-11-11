import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import net from "node:net";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CARD_URL = "https://adnanmansha1-create.github.io/";
const VCARD_LINES = [
  "BEGIN:VCARD",
  "VERSION:3.0",
  "N:Mansha;Adnan;;;",
  "FN:Adnan Mansha",
  "TITLE:Group Financial Controller",
  "TEL;TYPE=CELL:+971586850574",
  "EMAIL;TYPE=INTERNET:adnan.mansha.1@gmail.com",
  "URL:https://www.linkedin.com/in/adnan-mansha-3011214a",
  "ADR;TYPE=WORK:;;;Dubai;;;United Arab Emirates",
  "URL;TYPE=WORK:https://adnan-mansha.adnanmansha.chatgpt.site/",
  "END:VCARD",
];

function vcardLines(buf) {
  const text = Buffer.isBuffer(buf) ? buf.toString("latin1") : String(buf);
  if (!text.endsWith("\r\n")) throw new Error("vCard must end with CRLF");
  if (/(?<!\r)\n|\r(?!\n)/.test(text)) throw new Error("vCard line breaks must be CRLF only");
  const lines = text.slice(0, -2).split("\r\n");
  if (lines.some((line) => line.length === 0)) throw new Error("vCard contains a blank line");
  return lines;
}

function anchors(html) {
  return [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].map((match) => {
    const attrs = {};
    for (const attr of match[1].matchAll(/([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+)))?/g)) {
      attrs[attr[1].toLowerCase()] = attr[2] ?? attr[3] ?? attr[4] ?? "";
    }
    return { attrs, text: match[2].replace(/<[^>]+>/g, "").trim() };
  });
}

test("save contact hands off a valid vCard and the page QR opens this card", { timeout: 45000 }, async () => {
  const vcf = await readFile(path.join(root, "adnan-mansha.vcf"));
  assert.deepEqual(vcardLines(vcf), VCARD_LINES);
  const broken = Buffer.from(
    "BEGIN:VCARD\nVERSION:3.0\nFN:Adnan Mansha\nURL:https://adnan-mansha.adnanmansha.chatgpt.site/\r\nEND:VCARD\n",
    "latin1",
  );
  assert.throws(() => vcardLines(broken), /CRLF/);

  const html = await readFile(path.join(root, "index.html"), "utf8");
  assert.equal(html.includes("<script"), false);
  assert.doesNotMatch(html, /contact saved|saved automatically|has been added|added to your contacts/i);
  const links = anchors(html);
  const save = links.find((link) => link.text === "Save contact");
  assert.ok(save, "Save contact link missing");
  assert.equal(save.attrs.href, "adnan-mansha.vcf");
  assert.equal(Object.hasOwn(save.attrs, "download"), false);
  assert.equal(save.attrs["aria-describedby"], "save-contact-help");
  assert.match(html, /id="save-contact-help"[^>]*>[^<]*confirm the save when prompted/i);
  for (const href of [
    "tel:+971586850574",
    "mailto:adnan.mansha.1@gmail.com",
    "https://wa.me/971586850574",
    "https://www.linkedin.com/in/adnan-mansha-3011214a",
    "https://adnan-mansha.adnanmansha.chatgpt.site/",
  ]) {
    assert.ok(links.some((link) => link.attrs.href === href), href);
  }
  assert.match(html, /src="photo\.jpg"/);
  assert.match(html, /<h2>Scan to open this card<\/h2>\s*<img\b[^>]*id="card-qr"[^>]*>/);
  const qrTag = html.match(/<img\b[^>]*id="card-qr"[^>]*>/)[0];
  assert.match(qrTag, /src="qr\.png"/);
  assert.match(qrTag, new RegExp(`alt="QR code for ${CARD_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
  const websiteAt = html.indexOf('href="https://adnan-mansha.adnanmansha.chatgpt.site/"');
  const qrAt = html.indexOf('id="card-qr"');
  assert.ok(websiteAt !== -1 && qrAt > websiteAt, "QR must sit below the contact buttons");

  const decoded = execFileSync("zbarimg", ["--raw", "-q", path.join(root, "qr.png")], { encoding: "utf8" }).trim();
  assert.equal(decoded, CARD_URL);
  execFileSync("python3", ["-c", `
from PIL import Image
im = Image.open(${JSON.stringify(path.join(root, "qr.png"))}).convert("RGB")
w, h = im.size
assert w == h == 492, (w, h)
px = im.load()
band = 48
white, navy = (255, 255, 255), (15, 42, 68)
for i in range(w):
    for b in range(band):
        assert px[i, b] == white and px[i, h - 1 - b] == white
        assert px[b, i] == white and px[w - 1 - b, i] == white
assert px[band, band] == navy
`], { stdio: "inherit" });

  const attrs = await readFile(path.join(root, ".gitattributes"), "utf8");
  assert.match(attrs, /^adnan-mansha\.vcf -text$/m);

  await assertMobileHandoff();
});

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function assertMobileHandoff() {
  const types = {
    ".html": "text/html; charset=utf-8",
    ".vcf": "text/x-vcard",
    ".jpg": "image/jpeg",
    ".png": "image/png",
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const rel = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
    try {
      const body = await readFile(path.join(root, rel));
      res.writeHead(200, { "content-type": types[path.extname(rel)] || "application/octet-stream", "cache-control": "no-store" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const debugPort = await freePort();
  const profile = await mkdtemp(path.join(tmpdir(), "card-chrome-"));
  const chrome = spawn("google-chrome", [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "about:blank",
  ], { stdio: "ignore" });
  try {
    const version = await waitJson(debugPort);
    const cdp = await connect(version.webSocketDebuggerUrl);
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Network.enable", {}, sessionId);
    await cdp.send("Emulation.setUserAgentOverride", {
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    }, sessionId);

    for (const viewport of [
      { width: 390, height: 844, shot: "/tmp/card-390.png" },
      { width: 320, height: 700, shot: "/tmp/card-320.png" },
    ]) {
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: 2,
        mobile: true,
      }, sessionId);
      cdp.events.length = 0;
      await cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/` }, sessionId);
      await cdp.wait((event) => event.sessionId === sessionId && event.method === "Page.loadEventFired");
      await evaluate(cdp, sessionId, `Promise.all([...document.images].map((img) => img.complete ? null : new Promise((resolve) => { img.onload = img.onerror = resolve; })))`);
      const layout = await evaluate(cdp, sessionId, `(() => {
        const qr = document.getElementById("card-qr");
        const site = document.querySelector("a[href='https://adnan-mansha.adnanmansha.chatgpt.site/']");
        const save = document.getElementById("save-contact");
        const card = document.querySelector(".c");
        const box = (el) => el.getBoundingClientRect();
        const qrBox = box(qr), siteBox = box(site), cardBox = box(card);
        return {
          qrBelowSite: qrBox.top >= siteBox.bottom - 1,
          headingAboveQr: box(document.querySelector("h2")).bottom <= qrBox.top + 1,
          insideCard: qrBox.left >= cardBox.left - 1 && qrBox.right <= cardBox.right + 1 && qrBox.bottom <= cardBox.bottom + 1,
          square: Math.abs(qrBox.width - qrBox.height) < 2,
          width: qrBox.width,
          overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
          photo: document.querySelector("img.m").naturalWidth,
          alt: qr.alt,
          saveDownload: save.hasAttribute("download"),
          help: getComputedStyle(document.getElementById("save-contact-help")).display,
        };
      })()`);
      assert.equal(layout.qrBelowSite, true, `QR below buttons at ${viewport.width}`);
      assert.equal(layout.headingAboveQr, true, `heading above QR at ${viewport.width}`);
      assert.equal(layout.insideCard, true, `QR inside card at ${viewport.width}`);
      assert.equal(layout.square, true, `QR not distorted at ${viewport.width} (${layout.width})`);
      assert.equal(layout.overflow, false, `horizontal overflow at ${viewport.width}`);
      assert.ok(layout.width >= 160 && layout.width <= 246, `QR size ${layout.width} at ${viewport.width}`);
      assert.equal(layout.photo, 320);
      assert.equal(layout.alt, `QR code for ${CARD_URL}`);
      assert.equal(layout.saveDownload, false);
      assert.notEqual(layout.help, "none");
      const clip = await evaluate(cdp, sessionId, `(() => {
        window.scrollTo(0, 0);
        const box = document.getElementById("card-qr").getBoundingClientRect();
        return { x: box.x, y: box.y, width: box.width, height: box.height };
      })()`);
      const shot = await cdp.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
        clip: roundClip(clip),
      }, sessionId);
      const shotPath = viewport.shot.replace(".png", "-qr.png");
      await writeFile(shotPath, Buffer.from(shot.data, "base64"));
      const fromScreen = execFileSync("zbarimg", ["--raw", "-q", shotPath], { encoding: "utf8" }).trim();
      assert.equal(fromScreen, CARD_URL, `rendered QR at ${viewport.width}`);
      const page = await cdp.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
        clip: roundClip(await evaluate(cdp, sessionId, `(() => {
          const box = document.querySelector(".c").getBoundingClientRect();
          return { x: Math.max(0, box.x - 8), y: Math.max(0, box.y - 8), width: box.width + 16, height: box.height + 16 };
        })()`)),
      }, sessionId);
      await writeFile(viewport.shot, Buffer.from(page.data, "base64"));
    }

    const downloadDir = path.join(profile, "downloads");
    await mkdir(downloadDir, { recursive: true });
    await cdp.send("Browser.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: downloadDir,
      eventsEnabled: true,
    });
    cdp.events.length = 0;
    await evaluate(cdp, sessionId, `document.getElementById("save-contact").click()`);
    const started = await cdp.wait((event) => event.sessionId === sessionId && event.method === "Page.downloadWillBegin" && event.params.url.endsWith("/adnan-mansha.vcf"), 8000);
    await cdp.wait((event) => event.sessionId === sessionId && event.method === "Page.downloadProgress" && event.params.state === "completed", 8000);
    const bytes = await readFile(path.join(downloadDir, started.params.suggestedFilename));
    assert.deepEqual(vcardLines(bytes), VCARD_LINES);
    const servedType = await fetch(started.params.url).then((response) => response.headers.get("content-type"));
    assert.equal(servedType, "text/x-vcard");
    cdp.close();
  } finally {
    chrome.kill("SIGKILL");
    await new Promise((resolve) => {
      chrome.once("exit", resolve);
      setTimeout(resolve, 1500);
    });
    server.close();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await rm(profile, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
}

async function waitJson(port) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return await response.json();
    } catch { /* chrome still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Chrome DevTools did not start");
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const methods = new Map();
  const events = [];
  const waiters = [];
  const pump = () => {
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      const found = events.find(waiter.match);
      if (!found) continue;
      waiters.splice(index, 1);
      waiter.resolve(found);
    }
  };
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${methods.get(msg.id)} ${JSON.stringify(msg.error)}`));
      else resolve(msg.result || {});
    } else if (msg.method) {
      events.push(msg);
      pump();
    }
  });
  return {
    events,
    ready: new Promise((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("Chrome websocket failed")), { once: true });
    }),
    async send(method, params = {}, sessionId) {
      await this.ready;
      const msgId = ++id;
      const payload = { id: msgId, method, params };
      if (sessionId) payload.sessionId = sessionId;
      ws.send(JSON.stringify(payload));
      methods.set(msgId, method);
      return new Promise((resolve, reject) => pending.set(msgId, { resolve, reject }));
    },
    wait(match, timeout = 5000) {
      const existing = events.find(match);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out waiting for browser event")), timeout);
        waiters.push({ match, resolve: (msg) => { clearTimeout(timer); resolve(msg); } });
      });
    },
    close() { ws.close(); },
  };
}

function roundClip(clip) {
  return {
    x: Math.max(0, Math.floor(clip.x)),
    y: Math.max(0, Math.floor(clip.y)),
    width: Math.ceil(clip.width),
    height: Math.ceil(clip.height),
    scale: 1,
  };
}

async function evaluate(cdp, sessionId, expression) {
  const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
