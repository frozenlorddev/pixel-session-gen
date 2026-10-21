"use strict";
/**
 * Tiny in-memory status board so the page can show what is actually happening
 * instead of guessing. Keyed by the pairing id the browser already holds.
 *
 *   started → code_issued → waiting → paired → delivered
 *                                          ↘ failed
 *
 * Nothing here survives a restart, which is fine: a pairing never outlives one.
 */
const TTL_MS = 20 * 60 * 1000;
const board = new Map();

function set(id, patch) {
  if (!id) return;
  board.set(id, { ...(board.get(id) || {}), ...patch, updatedAt: Date.now() });
}

function get(id) {
  const row = board.get(id);
  if (!row) return null;
  if (Date.now() - row.updatedAt > TTL_MS) {
    board.delete(id);
    return null;
  }
  return row;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, row] of board) {
    if (now - row.updatedAt > TTL_MS) board.delete(id);
  }
}, 60_000).unref?.();

module.exports = { set, get, size: () => board.size };
