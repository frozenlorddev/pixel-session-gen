"use strict";
/**
 * Baileys — blacklord-baileys only.
 *
 * This is the exact build the bot runs, so a session generated here is produced
 * by the same code that will later consume it: same creds shape, same key
 * handling, same pairing semantics. No fallback to another build, because a
 * silent downgrade would produce sessions that look fine and then fail to
 * authenticate on the bot side.
 */
let mod;
try {
  mod = require("blacklord-baileys");
} catch (err) {
  throw new Error(
    "blacklord-baileys is required but not installed. Run: npm install blacklord-baileys@1.0.1",
  );
}

// 7.x forks expose helpers both as named exports and through `default`.
const lib = mod.default || mod;
const pick = (name) => lib[name] || mod[name];

const required = [
  "makeWASocket",
  "useMultiFileAuthState",
  "makeCacheableSignalKeyStore",
  "fetchLatestBaileysVersion",
  "Browsers",
];

const missing = required.filter((name) => typeof pick(name) !== "function" && !pick(name));
if (missing.length) {
  throw new Error(
    "blacklord-baileys is missing " + missing.join(", ") + " — wrong package version installed.",
  );
}

module.exports = {
  __resolved: "blacklord-baileys",
  makeWASocket: pick("makeWASocket"),
  useMultiFileAuthState: pick("useMultiFileAuthState"),
  makeCacheableSignalKeyStore: pick("makeCacheableSignalKeyStore"),
  fetchLatestBaileysVersion: pick("fetchLatestBaileysVersion"),
  Browsers: pick("Browsers"),
  delay: pick("delay") || ((ms) => new Promise((r) => setTimeout(r, ms))),
  DisconnectReason: pick("DisconnectReason"),
};
