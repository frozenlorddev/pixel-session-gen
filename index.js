"use strict";
require("events").EventEmitter.defaultMaxListeners = 200;

const express = require("express");
const path = require("path");
const fs = require("fs");

const pairRoute = require("./routes/pair");
const qrRoute = require("./routes/qr");
const { BOT_NAME, SESSION_ROOT } = require("./lib/session");
const { stats } = require("./lib/gate");
const board = require("./lib/state");

const PORT = process.env.PORT || 5000;
const app = express();

app.set("trust proxy", 1);
app.use(express.json({ limit: "64kb" }));
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h" }));

app.use("/code", pairRoute);
app.use("/qr", qrRoute);

/**
 * Render's free plan spins a service down after 15 minutes with no inbound
 * traffic. A pairing takes ~60-90 s and produces no requests on its own, so
 * the page pings this while it waits — one request keeps the whole window warm.
 */
app.get("/keepalive", (req, res) => res.json({ ok: true, t: Date.now(), ...stats() }));

/**
 * What the page polls while a pairing is in flight: started → waiting → paired
 * → delivered (or failed). Unknown ids simply read as "started".
 */
app.get("/status", (req, res) => {
  const id = String(req.query.id || "");
  const row = board.get(id);
  if (!row) return res.status(404).json({ ok: false, status: "unknown" });
  return res.json({ ok: true, status: row.status, reason: row.reason || null });
});

app.get("/healthz", (req, res) =>
  res.json({
    ok: true,
    bot: BOT_NAME,
    baileys: (() => {
      try {
        return require("./lib/wa").__resolved;
      } catch (e) {
        return "missing: " + e.message;
      }
    })(),
    sockets: stats().active,
    uptime: Math.round(process.uptime()),
  }),
);

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.use((req, res) => res.status(404).json({ ok: false, error: "Not found" }));

// Keep the session scratch directory out of git and off the live tree on boot.
fs.mkdirSync(SESSION_ROOT, { recursive: true });

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`[pixel-session] ${BOT_NAME} generator on :${PORT}`);
  try {
    console.log(`[pixel-session] baileys = ${require("./lib/wa").__resolved}`);
  } catch (e) {
    console.error("[pixel-session] " + e.message);
  }
});

const shutdown = () => server.close(() => process.exit(0));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

module.exports = app;
