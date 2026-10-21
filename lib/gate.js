"use strict";
/**
 * Two cheap guards for a free Render instance:
 *  - MAX_ACTIVE   sockets open at once (512 MB RAM dies at ~5 pairings)
 *  - per-IP rate  N starters per WINDOW_MS
 */
const MAX_ACTIVE = Number(process.env.MAX_ACTIVE || 4);
const PER_IP = Number(process.env.PER_IP || 3);
const WINDOW_MS = Number(process.env.WINDOW_MS || 10 * 60 * 1000);

let active = 0;
const seen = new Map(); // ip -> [timestamps]

function prune(now) {
  for (const [ip, hits] of seen) {
    const fresh = hits.filter((t) => now - t < WINDOW_MS);
    if (fresh.length) seen.set(ip, fresh);
    else seen.delete(ip);
  }
}

function enter(ip) {
  if (active >= MAX_ACTIVE) return false;
  const now = Date.now();
  prune(now);
  const hits = seen.get(ip) || [];
  if (hits.length >= PER_IP) return false;
  hits.push(now);
  seen.set(ip, hits);
  active += 1;
  return true;
}

function leave() {
  active = Math.max(0, active - 1);
}

module.exports = { enter, leave, gate: { enter, leave }, stats: () => ({ active }) };
