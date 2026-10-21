"use strict";
const express = require("express");
const pino = require("pino");
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
 * GET /code?number=2547XXXXXXXX
 * Returns the 8-character pairing code immediately, then keeps the socket
 * alive in the background, DMs the session to the user and cleans up.
 */
router.get("/", async (req, res) => {
  const raw = String(req.query.number || "").replace(/[^0-9]/g, "");
  if (raw.length < 7 || raw.length > 15) {
    return res.status(400).json({
      ok: false,
      error: "Enter the number in international format, digits only (e.g. 2547XXXXXXXX).",
    });
  }
  if (!gate.enter(req.ip)) {
    return res.status(429).json({
      ok: false,
      error: "Too many attempts from this IP. Wait a few minutes and try again.",
    });
  }

  const id = newId();
  board.set(id, { status: "started", number: "…" + raw.slice(-4) });
  let sent = false;
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
      generateHighQualityLinkPreview: false,
      markOnlineOnConnect: false,
      connectTimeoutMs: 60_000,
      keepAliveIntervalMs: 30_000,
      getMessage: async () => undefined,
    });

    sock.ev.on("creds.update", saveCreds);

    // The code must go out before "open", since the user has to type it in.
    if (!sock.authState.creds.registered) {
      await delay(1500);
      const code = await sock.requestPairingCode(raw);
      if (!res.headersSent) {
        sent = true;
        board.set(id, { status: "waiting" });
        res.json({ ok: true, code, id });
      }
    } else if (!res.headersSent) {
      sent = true;
      res.status(409).json({ ok: false, error: "Session already registered, reload the page." });
    }

    sock.ev.on("connection.update", async (u) => {
      const { connection, lastDisconnect } = u;

      if (connection === "open") {
        board.set(id, { status: "paired" });
        try {
          // Wait for a complete creds.json, then hand it back over DM.
          const creds = await waitForCreds(id);
          if (!creds) return;

          const sessionId = toSessionString(creds);
          const me = sock.user?.id;

          // 1/2 the SESSION_ID line
          await sock.sendMessage(me, { text: sessionId }).catch(() => {});
          // 2/2 how to use it
          await sock.sendMessage(me, { text: instructionsText(sessionId) }).catch(() => {});
          board.set(id, { status: "delivered" });
        } catch (err) {
          console.error("[pair] handoff failed:", err?.message || err);
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
        const code = lastDisconnect?.error?.output?.statusCode;
        // 401 = the device was logged out by the user; anything else is worth
        // one retry, but never after the session was already delivered.
        if (code === 401) {
          board.set(id, { status: "failed", reason: "The device was logged out before pairing finished." });
          await finish();
        }
        if (!sent && !res.headersSent) {
          res.status(502).json({
            ok: false,
            error: "WhatsApp closed the connection. Try again.",
          });
          sent = true;
        }
        if (code === 401 || code === 403) await finish();
      }
    });
  } catch (err) {
    console.error("[pair] start failed:", err?.message || err);
    board.set(id, { status: "failed", reason: "Pairing could not start. Try again." });
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: "Service unavailable. Try again." });
    }
    await finish();
  }
});

module.exports = router;
