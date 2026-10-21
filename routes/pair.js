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
const MAX_RECONNECTS = Number(process.env.MAX_RECONNECTS || 6);

/**
 * One live socket per phone number. WhatsApp keys a pending link to the newest
 * registration for that number, so an older attempt still holding a socket is
 * how an approval ends up delivered to nobody.
 */
const LIVE = new Map(); // number -> { id, kill }
const LOG = [];

function note(id, event, extra) {
  LOG.push({ t: new Date().toISOString(), id, event, ...(extra || {}) });
  if (LOG.length > 80) LOG.shift();
}

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
 * The rule that makes a code actually complete, learned the hard way:
 *
 *   ONE code per attempt. Asking for a second code for the same number silently
 *   invalidates the first — so a user already typing it on their phone sits on
 *   "Logging in…" forever while the server waits for an approval that can no
 *   longer arrive.
 *
 * So: issue the code exactly once, then keep a socket alive, and if WhatsApp
 * drops it (515 "restart required" is routine) rebuild the socket WITHOUT
 * requesting a new code. The pairing registration lives in creds.json, not in
 * the socket, so the reconnected socket still receives the phone's approval.
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
  let reconnects = 0;
  let finished = false;
  let watchdog = null;
  let version = null;
  let state = null;
  let saveCreds = null;
  let code = null; // the single code this attempt owns

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
    if (LIVE.get(raw)?.id === id) LIVE.delete(raw);
    if (reason) board.set(id, { status: "failed", reason });
    note(id, reason ? "failed" : "finished", { reason, number: raw });
    await cleanUp(id);
  };

  // Supersede any earlier attempt still holding a socket for this number.
  const previous = LIVE.get(raw);
  if (previous && previous.id !== id) {
    note(id, "superseding", { number: raw, previous: previous.id });
    try {
      previous.kill();
    } catch {}
  }
  LIVE.set(raw, {
    id,
    kill: () => {
      finished = true;
      clearTimeout(watchdog);
      try {
        sock?.ws?.close();
      } catch {}
    },
  });

  /** Armed once, when the code is issued: a code's lifetime never extends. */
  const armWatchdog = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(
      () => finish("No approval after 5 minutes. The code expired — start again."),
      LINK_TIMEOUT_MS,
    );
  };

  function attach(s) {
    s.ev.on("creds.update", saveCreds);

    s.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
      if (finished) return;
      if (s !== sock) return;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      console.log(
        `[pair ${id}] connection=${connection || "-"} code=${statusCode || "-"} haveCode=${!!code}`,
      );
      note(id, "connection", { connection: connection || null, code: statusCode || null });

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
          const me = s.user?.id;
          await s.sendMessage(me, { text: sessionId }).catch(() => {});
          await s.sendMessage(me, { text: instructionsText(sessionId) }).catch(() => {});
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

      if (connection !== "close") return;

      if (statusCode === 401 || statusCode === 403 || statusCode === 405) {
        await finish(
          "WhatsApp refused the link (logged out or blocked). Wait 10 minutes, then start again.",
        );
        return;
      }

      if (reconnects >= MAX_RECONNECTS) {
        await finish("WhatsApp kept dropping the link. Wait 10 minutes and start again.");
        return;
      }

      reconnects += 1;
      board.set(id, { status: "waiting", code, attempt: reconnects + 1, reconnects });
      console.log(`[pair ${id}] reconnecting (${reconnects}/${MAX_RECONNECTS}), code ${code} stays valid`);
      note(id, "reconnect", { attempt: reconnects + 1, code, closeCode: statusCode || null });

      try {
        s.ws?.close();
      } catch {}
      await delay(2000);
      if (finished) return;

      // Rebuild the socket, keep the code: never request a second one.
      await open(false);
    });
  }

  /** requestPairingCode must run once per attempt, on a settled socket. */
  async function requestCode(s) {
    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await delay(attempt === 1 ? 2000 : 2500);
        return await s.requestPairingCode(raw, generatePairingCode());
      } catch (err) {
        lastErr = err;
        console.error(`[pair ${id}] requestPairingCode attempt ${attempt}:`, err?.message || err);
      }
    }
    throw lastErr;
  }

  async function open(issueCode) {
    try {
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
        generateHighQualityLinkPreview: true,
        markOnlineOnConnect: true,
        connectTimeoutMs: 60_000,
        keepAliveIntervalMs: 25_000,
        getMessage: async () => undefined,
      });

      attach(sock);

      if (issueCode) {
        code = await requestCode(sock);
        board.set(id, {
          status: "waiting",
          code,
          attempt: reconnects + 1,
          reconnects,
          codeAt: Date.now(),
          number: "+" + raw,
        });
        console.log(`[pair ${id}] code ${code} for +${raw} (attempt ${reconnects + 1})`);
        note(id, "code", { code, number: raw });
        reply(200, { ok: true, code, id });
        armWatchdog();
      }
    } catch (err) {
      const why = explain(err);
      console.error("[pair] start failed:", why.code, err?.message || err);
      note(id, "start_failed", { code: why.code, message: String(err?.message || err) });
      reply(why.http, { ok: false, code: why.code, error: why.text });
      await finish(why.text);
    }
  }

  board.set(id, { status: "started", number: "+" + raw });

  try {
    ({ version } = await fetchLatestBaileysVersion());
    ({ state, saveCreds } = await useMultiFileAuthState(sessionDir(id)));
  } catch (err) {
    const why = explain(err);
    reply(why.http, { ok: false, code: why.code, error: why.text });
    await finish(why.text);
    return;
  }

  await open(true);
});

/** Read-only view of live attempts, surfaced at /diag. */
router.diag = () => ({
  live: [...LIVE.entries()].map(([number, v]) => ({ number: "+" + number, id: v.id })),
  log: LOG.slice(-30),
});

module.exports = router;
