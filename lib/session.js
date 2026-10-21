"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const BOT_NAME = process.env.BOT_NAME || "Pixel X Ultra";
const SESSION_ROOT = path.join(__dirname, "..", "routes", "session");

/** Random per-attempt folder name so two users never collide. */
function newId() {
  return crypto.randomBytes(8).toString("hex");
}

function sessionDir(id) {
  return path.join(SESSION_ROOT, id);
}

async function cleanUp(id) {
  try {
    await fs.promises.rm(sessionDir(id), { recursive: true, force: true });
  } catch {
    /* already gone */
  }
}

/**
 * Poll for creds.json. Baileys writes it on the creds.update event, which can
 * land a few seconds after "connection open", and the file can be read while
 * still being written — so require a stable, parseable payload.
 */
async function waitForCreds(id, { attempts = 20, gapMs = 3000 } = {}) {
  const file = path.join(sessionDir(id), "creds.json");
  for (let i = 0; i < attempts; i++) {
    try {
      const raw = await fs.promises.readFile(file, "utf8");
      if (raw && raw.length > 100) {
        const creds = JSON.parse(raw);
        if (creds && creds.me && creds.me.id) return creds;
      }
    } catch {
      /* not written yet */
    }
    await new Promise((r) => setTimeout(r, gapMs));
  }
  return null;
}

/**
 * Plain base64 of creds.json — no prefix.
 * The bot's parseSessionId() strips only `data:application/json;base64,` and
 * `base64:`, then JSON.parses the raw value or its base64 decode, so a
 * "Pixel~" style prefix would make it fail. Plain base64 always parses.
 */
function toSessionString(creds) {
  return Buffer.from(JSON.stringify(creds), "utf8").toString("base64");
}


/**
 * 8 characters, A-Z 0-9 — the same shape WhatsApp issues. Passing our own code
 * matches how the Elite generator calls requestPairingCode and removes any
 * dependency on the library's code generator.
 */
function generatePairingCode() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let out = "";
  const bytes = require("crypto").randomBytes(8);
  for (let i = 0; i < 8; i++) out += chars[bytes[i] % chars.length];
  return out;
}

function instructionsText(sessionId) {
  return (
    `✅ *SESSION READY — ${BOT_NAME}*\n\n` +
    `Paste this as *SESSION_ID* in your .env (one line, keep it exactly as is):\n\n` +
    `${sessionId}\n\n` +
    `Your bot decodes it on boot and writes ./session/creds.json.\n\n` +
    `⚠️ Anyone holding this string can drive your WhatsApp account. ` +
    `Never share it, never commit it, and regenerate it if it leaks.`
  );
}

/** Warning captured here so it's impossible to ship the old auto-join. */
function consentNote() {
  return (
    `This generator does not join you to any group or channel. ` +
    `It only links the device you approve and hands the session back to you.`
  );
}

module.exports = {
  BOT_NAME,
  generatePairingCode,
  SESSION_ROOT,
  newId,
  sessionDir,
  cleanUp,
  waitForCreds,
  toSessionString,
  instructionsText,
  consentNote,
};
