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
  generatePairingCode,
} = require("../lib/session");
const { gate } = require("../lib/gate");
const board = require("../lib/state");

const router = express.Router();
const silent = pino({ level: "silent" });

const LINK_TIMEOUT_MS = Number(process.env.LINK_TIMEOUT_MS || 5 * 60 * 1000);
const MAX_CODE_RETRIES = Number(process.env.MAX_CODE_RETRIES || 2);

/**
 * WhatsApp answers a bad number and a throttled IP very differently, but both
 * look like "it just doesn't work" in the UI. Translate the common ones so the
 * page can tell the user to wait instead of hammering the button.
 */
function explain(err) {
  const status = err?.output?.statusCode || err?.statusCode || err?.status;
  const msg = String(err?.message || err || "");
  if (status === 429 || /rate[-_ ]?overlimit|too many/i.test(msg)) {
    return {
      http: 429,
      code: "rate_limited",
      text: "WhatsApp is throttling pairing attempts. Wait about 10 minutes and try once — retrying extends the block.",
    };
  }
  if (status === 400 || /bad[- ]?request|invalid number|not-authorized/i.test(msg)) {
    return {
      http: 400,
      code: "bad_number",
      text: "WhatsApp rejected that number. Check the country code and remove any leading 0.",
    };
  }
  return { http: 500, code: "unavailable", text: "Couldn't start pairing. Try again in a minute." };
}

/**
 * GET /code?number=2547XXXXXXXX
 *
 * Order matters and is the fix for "stuck on login":
 *   1. build the socket
 *   2. attach connection.update BEFORE asking for a code — otherwise a `close`
 *      that lands while the code is being requested is never seen and the page
 *      waits forever on a socket that is already dead
 *   3. issue the code, publish it to the status board
 *   4. keep the socket alive until `open`, re-issuing the code if WhatsApp drops
 *      it (a pairing code dies with the socket that requested it)
 */
router.get("/", async (req, res) => {
  const raw = String(req.query.number || "").replace(/[^0-9]/g, "");
  if (raw.length < 8 || raw.length > 15) {
    return res.status(400).json({
      ok: false,
      code: "bad_number",
      error: "Enter the number in international format, digits only (e.g. 2547XXXXXXXX).",
    });
  }
  if (!gate.enter(req.ip)) {
    return res.status(429).json({
      ok: false,
      code: "busy",
      error: "Too many pairing attempts from this IP. Wait a few minutes.",
    });
  }

  const id = newId();
  let sock = null;
  let answered = false;
  let retries = 0;
  let finished = false;
  let watchdog = null;

  const reply = (status, body) => {
    if (answered) return;
    answered = true;
    if (!res.headersSent) res.status(status).json(body);
  };

  const finish = async (reason) => {
    if (finished) return;
    finished = true;
    clearTimeout(watchdog);
    gate.leave();
    try {
      sock?.ws?.close();
    } catch {}
    if (reason) board.set(id, { status: "failed", reason });
    await cleanUp(id);
  };

  const armWatchdog = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(
      () => finish("No approval after 5 minutes. The code expired — start again."),
      LINK_TIMEOUT_MS,
    );
  };

  board.set(id, { status: "started", number: "+" + raw });

  try {
    const { version } = await fetchLatestBaileysVersion();
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir(id));

    sock = makeWASocket({
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
      keepAliveIntervalMs: 25_000,
      getMessage: async () => undefined,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      console.log(`[pair ${id}] connection=${connection || "-"} code=${statusCode || "-"}`);

      if (connection === "open") {
        clearTimeout(watchdog);
        board.set(id, { status: "paired" });
        try {
          const creds = await waitForCreds(id);
          if (!creds) {
            await finish("Linked, but creds.json never became readable. Try again.");
            return;
          }
          const sessionId = toSessionString(creds);
          const me = sock.user?.id;
          await sock.sendMessage(me, { text: sessionId }).catch(() => {});
          await sock.sendMessage(me, { text: instructionsText(sessionId) }).catch(() => {});
          board.set(id, { status: "delivered" });
        } catch (err) {
          console.error("[pair] handoff failed:", err?.message || err);
          board.set(id, { status: "failed", reason: "Could not deliver the session over WhatsApp." });
        } finally {
          await delay(1500);
          await finish();
        }
        return;
      }

      if (connection === "close") {
        if (statusCode === 401 || statusCode === 403) {
          await finish("WhatsApp logged the device out before the link finished. Start again.");
          return;
        }
        if (!finished && retries < MAX_CODE_RETRIES) {
          retries += 1;
          console.log(`[pair ${id}] socket dropped — re-issuing code (${retries}/${MAX_CODE_RETRIES})`);
          await delay(2500);
          try {
            const code = await sock.requestPairingCode(raw, generatePairingCode());
            board.set(id, { status: "waiting", code, reissued: true });
            console.log(`[pair ${id}] new code ${code}`);
            armWatchdog();
          } catch (err) {
            const why = explain(err);
            console.error("[pair] re-issue failed:", why.code, err?.message || err);
            await finish(why.text);
          }
          return;
        }
        await finish("WhatsApp closed the pairing socket. Start again.");
      }
    });

    /**
     * 6.7.24 throws "Connection Closed" if the code is requested before the
     * websocket has settled, and the Elite generator works around it with a
     * short delay plus an explicit 8-character code. Same recipe here, with one
     * retry on a fresh socket state.
     */
    let code = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await delay(2000);
        code = await sock.requestPairingCode(raw, generatePairingCode());
        break;
      } catch (err) {
        console.error(`[pair ${id}] requestPairingCode attempt ${attempt} failed:`, err?.message || err);
        if (attempt === 2) throw err;
        await delay(3000);
      }
    }

    board.set(id, { status: "waiting", code });
    console.log(`[pair ${id}] code ${code} for +${raw}`);
    reply(200, { ok: true, code, id });
    armWatchdog();
  } catch (err) {
    const why = explain(err);
    console.error("[pair] start failed:", why.code, err?.message || err);
    reply(why.http, { ok: false, code: why.code, error: why.text });
    await finish(why.text);
  }
});

module.exports = router;
