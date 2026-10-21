"use strict";
const express = require("express");
const pino = require("pino");
const QRCode = require("qrcode");
const {
  makeWASocket,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  Browsers,
  delay,
} = require("../lib/wa");
const {
  newId,
  sessionDir,
  cleanUp,
  waitForCreds,
  toSessionString,
  instructionsText,
} = require("../lib/session");
const { gate } = require("../lib/gate");
const board = require("../lib/state");

const router = express.Router();
const silent = pino({ level: "silent" });

const ATTEMPT_TTL_MS = 4 * 60 * 1000;
const MAX_REBUILDS = 4;

/**
 * QR attempts live here rather than in a request handler, because a QR pairing
 * is a conversation: WhatsApp rotates the QR roughly every 20 s and drops the
 * socket when one expires. The page polls /qr/state and gets the *current*
 * image, so an expired QR is replaced instead of leaving the scan failing.
 */
const attempts = new Map(); // id -> attempt

async function renderQr(raw) {
  return QRCode.toDataURL(raw, { margin: 1, width: 320 });
}

function createAttempt(id) {
  const a = {
    id,
    sock: null,
    status: "started",
    qr: null,
    reason: null,
    rebuilds: 0,
    finished: false,
    updatedAt: Date.now(),
    watchdog: null,
  };
  attempts.set(id, a);

  const finish = async (reason) => {
    if (a.finished) return;
    a.finished = true;
    clearTimeout(a.watchdog);
    gate.leave();
    try {
      a.sock?.ws?.close();
    } catch {}
    if (reason) {
      a.status = "failed";
      a.reason = reason;
      board.set(id, { status: "failed", reason });
    }
    await cleanUp(id);
    // Keep the row briefly so the page can read the failure, then drop it.
    setTimeout(() => attempts.delete(id), 60_000).unref?.();
  };
  a.finish = finish;

  a.arm = () => {
    clearTimeout(a.watchdog);
    a.watchdog = setTimeout(
      () => finish("No scan after 4 minutes. The QR expired — start again."),
      ATTEMPT_TTL_MS,
    );
  };

  return a;
}

async function start(a, version) {
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir(a.id));

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, silent),
    },
    printQRInTerminal: false,
    logger: silent,
    browser: Browsers.macOS("Desktop"),
    syncFullHistory: false,
    markOnlineOnConnect: true,
    connectTimeoutMs: 60_000,
    keepAliveIntervalMs: 25_000,
    getMessage: async () => undefined,
  });

  a.sock = sock;
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (u) => {
    if (a.finished || sock !== a.sock) return;
    const { connection, qr, lastDisconnect } = u;

    if (qr) {
      a.qr = await renderQr(qr);
      a.status = "waiting";
      a.updatedAt = Date.now();
      board.set(a.id, { status: "waiting" });
    }

    if (connection === "open") {
      clearTimeout(a.watchdog);
      a.status = "paired";
      board.set(a.id, { status: "paired" });
      try {
        const creds = await waitForCreds(a.id);
        if (!creds) {
          await a.finish("Linked, but creds.json never became readable. Try again.");
          return;
        }
        const sessionId = toSessionString(creds);
        const me = sock.user?.id;
        await sock.sendMessage(me, { text: sessionId }).catch(() => {});
        await sock.sendMessage(me, { text: instructionsText(sessionId) }).catch(() => {});
        a.status = "delivered";
        board.set(a.id, { status: "delivered" });
      } catch (err) {
        console.error("[qr] handoff failed:", err?.message || err);
        await a.finish("Could not deliver the session over WhatsApp.");
        return;
      }
      await delay(1200);
      a.finished = true;
      try {
        sock.ws?.close();
      } catch {}
      gate.leave();
      await cleanUp(a.id);
      setTimeout(() => attempts.delete(a.id), 60_000).unref?.();
      return;
    }

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === 401 || code === 403 || code === 405) {
        await a.finish("WhatsApp refused the link. Wait 10 minutes, then start again.");
        return;
      }
      if (a.rebuilds >= MAX_REBUILDS) {
        await a.finish("WhatsApp kept dropping the QR. Reload the page and try again.");
        return;
      }
      a.rebuilds += 1;
      try {
        sock.ws?.close();
      } catch {}
      await delay(1500);
      if (a.finished) return;
      try {
        await start(a, version);
      } catch (err) {
        console.error("[qr] rebuild failed:", err?.message || err);
      }
    }
  });
}

/**
 * GET /qr        → { ok, id, qr }   (first QR; kept for the existing button)
 * GET /qr/state  → { ok, status, qr, reason }  (poll this: fresh QR each time)
 */
router.get("/", async (req, res) => {
  if (!gate.enter(req.ip)) {
    return res.status(429).json({
      ok: false,
      error: "Too many attempts from this IP. Wait a few minutes.",
    });
  }

  const id = newId();
  const a = createAttempt(id);
  board.set(id, { status: "started" });

  try {
    const { version } = await fetchLatestBaileysVersion();
    await start(a, version);
    a.arm();

    // Wait up to 25 s for the first QR rather than answering empty.
    for (let i = 0; i < 50 && !a.qr; i++) {
      if (a.finished) break;
      await delay(500);
    }
    if (!a.qr) {
      await a.finish("WhatsApp did not send a QR. Try again in a minute.");
      return res.status(502).json({ ok: false, error: "QR did not arrive. Try again." });
    }
    return res.json({ ok: true, id, qr: a.qr });
  } catch (err) {
    console.error("[qr] start failed:", err?.message || err);
    await a.finish("Could not start QR pairing. Try again in a minute.");
    return res.status(500).json({ ok: false, error: "Service unavailable. Try again." });
  }
});

router.get("/state", (req, res) => {
  const a = attempts.get(String(req.query.id || ""));
  if (!a) return res.status(404).json({ ok: false, status: "unknown" });
  return res.json({
    ok: true,
    status: a.status,
    qr: a.qr,
    reason: a.reason,
    rebuilds: a.rebuilds,
  });
});

module.exports = router;
