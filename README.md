# Pixel X Ultra — Session Generator

Landing page that pairs a WhatsApp number and hands back a `SESSION_ID` in the
exact format **Pixel X Ultra** parses. Country picker with 195 dial codes, an
8-character pairing code, a QR fallback, and live pairing status.

The page is branded for Pixel X Ultra: the bot's own artwork is the hero and the
same image is used, blurred and dimmed, as the page background
(`public/img/pixel.jpg`).

Rebuilt from `EliteProTech/ELITEPRO-SESSION-ID` with three changes that matter:

1. **Format matches the bot.** The bot's `parseSessionId()` strips only
   `data:application/json;base64,` and `base64:` prefixes before decoding. It does
   **not** understand `Pixel~` / `PXU-` prefixes, so this generator emits **plain
   base64 of `creds.json`** — the one shape that always parses. Raw one-line JSON
   is also accepted by the bot if you prefer to paste that.
2. **No side effects on the paired account.** The original calls
   `groupAcceptInvite("Jx5g9WIAzFe4BPB3tXLzCU")` on every successful pairing, which
   force-adds the user to the author's group, plus a `newsletterFollow(...)`. Both
   are removed here. Nothing is joined, nothing is followed.
3. **Built for Render's free plan.** It respects `PORT`, starts with plain
   `node index.js` (no pm2), and the page pings `/keepalive` while a pairing is in
   flight so the service isn't spun down mid-handoff.

**Baileys: `blacklord-baileys@1.0.1` only.** No fallback and no second build in
`node_modules` — the library that mints the session is the library that later
consumes it, so creds can't come from a differently-behaved fork. If the package
is missing the app refuses to boot with
`blacklord-baileys is required but not installed` instead of quietly downgrading.

---

## Deploy on Render

### Blueprint (one click)

1. Push this folder to a GitHub repo.
2. Render → **New → Blueprint** → pick the repo. `render.yaml` is read
   automatically: free plan, `node index.js`, health check `/healthz`.

### Manual

Render → **New → Web Service** → connect the repo, then:

```
Runtime         Node
Build Command   npm install --omit=dev
Start Command   node index.js
Instance Type   Free
Health Check    /healthz
```

Add env vars if you want to override the defaults:

| Variable | Default | Meaning |
|----------|---------|---------|
| `BOT_NAME` | `Pixel X Ultra` | Shown on the page and in the DM |
| `MAX_ACTIVE` | `4` | Concurrent pairing sockets (free 512 MB dies above ~5) |
| `PER_IP` | `3` | Pairing attempts per IP |
| `WINDOW_MS` | `600000` | Rate-limit window (10 min) |
| `NODE_VERSION` | `20.18.1` | blacklord-baileys targets Node 20 |

---

## How it behaves

1. User enters a number → `GET /code?number=…` returns the 8-char code instantly.
2. They enter it in **WhatsApp → Linked devices → Link with phone number**.
3. On `connection open` the app waits for a complete `creds.json`, base64-encodes
   it, and **DMs it to that same account** ("Message yourself") as two messages:
   the one-line `SESSION_ID`, then the paste instructions.
4. The socket is closed and `routes/session/<id>/` is deleted. Nothing persists.

The session is never returned over HTTP — only to the account that paired.

## Free-plan limits you should expect

- Spins down after **15 minutes** with no inbound traffic; cold start ≈ 1 min.
  While a pairing is open the page's `/keepalive` ping keeps it warm.
- Ephemeral disk — but that's fine here, since the session folder lives for
  under two minutes and is deleted either way.
- **750 instance hours/month** per workspace. One always-warm service is ~744 h,
  so a second free service would eat into the same allowance.
- A spin-down or restart **during** a pairing loses that attempt; the user just
  retries.

## Page behaviour

- Country list is fetched from `public/countries.json` (195 entries, searchable by
  name or dial code). The prefix box stays editable for numbers typed manually.
- `+1`, `+7` and `+39` appear twice (US/Canada, Kazakhstan/Russia, Italy/Vatican
  City) — the picker shows each country separately and both dial the same digits.
- While a pairing is in flight the page polls `/status` every 3 s and pings
  `/keepalive` every 20 s, so the handoff survives Render's idle spin-down.
- The session is never rendered in the browser; the page only says whether it was
  delivered.

## Endpoints

| Route | Purpose |
|-------|---------|
| `GET /` | UI |
| `GET /code?number=2547…` | `{ ok, code, id }` — 8-char pairing code |
| `GET /qr` | `{ ok, qr }` — data-URL QR |
| `GET /status?id=…` | `started` → `waiting` → `paired` → `delivered` / `failed` |
| `GET /keepalive` | Warm-up ping, also reports active sockets |
| `GET /healthz` | Bot name, resolved Baileys build, uptime |

## Security notes

- Whoever holds the `SESSION_ID` controls that WhatsApp account — treat it like a
  password. The DM goes to the account owner only; the page never displays it.
- While pairing, `creds.json` exists briefly on the server's disk under
  `routes/session/<random-id>/`. It is removed on every exit path, including errors.
- If you make this public, keep the rate limit on. It stops one IP from opening
  dozens of sockets and knocking a 512 MB instance over.

## Local run

```bash
npm install
node index.js          # http://localhost:5000
```
