"use strict";
/**
 * Baileys — @whiskeysockets/baileys 6.7.24, the exact build the Elite session
 * generator pairs with. It is the baseline that reliably issues a pairing code
 * and completes the link; the creds.json it writes is plain JSON and loads fine
 * on the bot's 7.x fork.
 *
 * Single dependency on purpose: a resolver that silently picks a different
 * build is how you end up with a code that is issued but never completes.
 */
const mod = require("@whiskeysockets/baileys");

const makeWASocket = mod.makeWASocket || mod.default;
const {
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  Browsers,
  delay,
  DisconnectReason,
} = mod;

if (typeof makeWASocket !== "function" || typeof useMultiFileAuthState !== "function") {
  throw new Error(
    "@whiskeysockets/baileys 6.7.24 is required. Run: npm install @whiskeysockets/baileys@6.7.24",
  );
}

module.exports = {
  __resolved: "@whiskeysockets/baileys@" + (require("@whiskeysockets/baileys/package.json").version || "?"),
  makeWASocket,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  Browsers,
  delay: delay || ((ms) => new Promise((r) => setTimeout(r, ms))),
  DisconnectReason,
};
