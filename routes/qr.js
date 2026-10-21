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

/**
 * GET /qr  → { qr: "data:image/png;base64,..." }
 * Same handoff as /code, but the user scans a QR in WhatsApp instead of
 * typing an 8-character code.
 */
router.get("/", async (req, res) => {
  if (!gate.enter(req.ip)) {
    return res.status(429).json({
      ok: false,
      error: "Too many attempts from this IP. Wait a few minutes.",
    });
  }

  const id = newId();
  board.set(id, { status: "started" });
  let sentQr = false;
  let closed = false;

  const finish = async () => {
    if (closed) return;
    closed = true;
    gate.leave();
    await cleanUp(id);
  };

  try {
    const { version } = await fetchLatestBaileysVersion();
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir(id));

    const sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, silent),
      },
      printQRInTerminal: false,
      logger: silent,
      browser: Browsers.macOS("Safari"),
      syncFullHistory: false,
      markOnlineOnConnect: false,
      connectTimeoutMs: 60_000,
      keepAliveIntervalMs: 30_000,
      getMessage: async () => undefined,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (u) => {
      const { connection, qr } = u;

      if (qr && !sentQr) {
        sentQr = true;
        const dataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
        board.set(id, { status: "waiting" });
        if (!res.headersSent) res.json({ ok: true, qr: dataUrl, id });
      }

      if (connection === "open") {
        board.set(id, { status: "paired" });
        try {
          const creds = await waitForCreds(id);
          if (!creds) return;
          const sessionId = toSessionString(creds);
          const me = sock.user?.id;
          await sock.sendMessage(me, { text: sessionId }).catch(() => {});
          await sock.sendMessage(me, { text: instructionsText(sessionId) }).catch(() => {});
          board.set(id, { status: "delivered" });
        } catch (err) {
          console.error("[qr] handoff failed:", err?.message || err);
          board.set(id, { status: "failed", reason: "Could not deliver the session over WhatsApp." });
        } finally {
          await delay(2000);
          try {
            sock.ws?.close();
          } catch {}
          await finish();
        }
      }

      if (connection === "close") {
        if (!res.headersSent) {
          res.status(502).json({ ok: false, error: "QR expired. Reload and try again." });
        }
        await finish();
      }
    });
  } catch (err) {
    console.error("[qr] start failed:", err?.message || err);
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: "Service unavailable. Try again." });
    }
    await finish();
  }
});

module.exports = router;
