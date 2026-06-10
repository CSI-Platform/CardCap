# CardCap — Real Auth + iContact Export + Abuse Guard (v1 design)

Date: 2026-06-09
Status: Approved pending user review

## Goal

Replace the shared beta-code login with real per-user accounts, add an iContact-formatted CSV export, and protect the free, open-signup app from spam/cost abuse. Product stays free; Stripe deferred.

**Success metric:** 10 weekly-active users within 60 days of launch, else stop investing.
**Timebox:** implementation ≤ 2 weekends.

## Decisions (made with Cody)

| Decision | Choice | Why |
|---|---|---|
| Auth method | Email magic link | Works with any email incl. company addresses (title reps); no passwords |
| Email provider | **Resend** (existing account, verified domain) | Established sender reputation beats Cloudflare Email Service (public beta) against corporate spam filters (Proofpoint/Mimecast at title companies). CF Email Service is the future swap once GA — email sending is isolated behind one function to keep that swap ~5 lines. |
| iContact integration | CSV export preset (manual upload by user) | Zero credentials, zero API risk, ships now. Live API push only if friction proves real. |
| Daily extraction cap | **25 cards/user/day** | Covers conference days (the wow moment); worst-case cost still pennies. |
| Existing beta data | Fresh start (with one-command D1 snapshot first) | Beta data is test data; snapshot is free insurance. |
| Bot/burst guard | Turnstile on login + Workers Rate Limiting binding (GA) | Both free, native Cloudflare, no deps. |

## Architecture

All on existing Cloudflare Worker (`cardcap`). No new npm dependencies. Resend and Turnstile called via plain `fetch`.

### Config

| Item | Kind | Notes |
|---|---|---|
| `SENDER_EMAIL` | var | e.g. `cardcap@copperstateit.com` (must be on the Resend-verified domain) |
| `TURNSTILE_SITE_KEY` | var | public, used by frontend widget |
| `SESSION_SECRET` | secret | HMAC key for session cookies |
| `RESEND_API_KEY` | secret | existing Resend account |
| `TURNSTILE_SECRET_KEY` | secret | server-side siteverify |
| `RL_LINK_EMAIL` | ratelimit binding | 2 / 60s, keyed by email |
| `RL_LINK_IP` | ratelimit binding | 5 / 60s, keyed by IP |
| `RL_UPLOAD` | ratelimit binding | 10 / 60s, keyed by user id |
| `BETA_ACCESS_CODE` | remove | beta path deleted |

### Data (migration `0002_login_tokens.sql`)

```sql
CREATE TABLE IF NOT EXISTS login_tokens (
  token_hash TEXT PRIMARY KEY,   -- SHA-256 hex of the raw token (raw token never stored)
  email TEXT NOT NULL,
  expires_at TEXT NOT NULL,      -- ISO, issued_at + 15 minutes
  used_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_login_tokens_email ON login_tokens(email);
```

`users` table already exists. User id convention: `email:<lowercased-email>` (matches the existing Cloudflare Access path). First verified login upserts the user row (`auth_provider = 'magic-link'`).

### Auth flow

1. `POST /api/auth/request-link` `{ email, turnstileToken }`
   - Validate email shape → verify Turnstile via siteverify → check `RL_LINK_EMAIL` + `RL_LINK_IP` → generate token (`crypto.randomUUID()` ×2 joined), store SHA-256 hash with 15-min expiry → send email via Resend with link `https://<host>/api/auth/verify?token=<raw>`.
   - Response is always `{ ok: true }` for valid-shaped emails (no account enumeration).
2. `GET /api/auth/verify?token=`
   - Hash lookup; must be unexpired and unused → mark used, upsert user → set session cookie → `302` redirect to `/`.
   - Invalid/expired/used → small friendly HTML page: "Link expired or already used" + button back to login.
3. Session cookie `cardcap_session` = `v1.<b64url(userId)>.<expiresEpoch>.<b64url(hmacSha256(SESSION_SECRET, userId + "." + expiresEpoch))>`; HttpOnly, Secure, SameSite=Lax, Max-Age 30 days. Stateless; revocation = rotate `SESSION_SECRET` (acceptable v1 trade-off, noted).
4. `currentUser()` order: valid session cookie → Cloudflare Access headers (Cody's admin backdoor, kept) → if `SESSION_SECRET` unset (local dev), fall back to local user (preserves current dev flow) → else null/401.
5. `POST /api/auth/logout` clears the cookie. `GET /api/me` → `{ email }` or 401.

Local dev: with no `RESEND_API_KEY`, `sendLoginEmail()` logs the magic link to the console instead of sending. Turnstile uses Cloudflare's always-pass test sitekey locally.

### Quota (cost guard)

- Before R2 upload + OpenAI call: `SELECT COUNT(*) FROM extraction_jobs WHERE user_id = ? AND created_at >= <UTC midnight>`. If ≥ 25 → `429` with `"Daily limit of 25 cards reached — resets tonight (UTC). Email us if you legitimately need more."`
- Check runs before any spend (no R2 put, no OpenAI call). Mild race on parallel uploads is accepted (not money-critical at these prices).
- `RL_UPLOAD` (10/min) blunts scripted bursts beneath the daily cap.

### iContact CSV export

New `exportContactsIContactCsv()` in `src/shared/exporters.ts`:

- Header row: `Email,First Name,Last Name,Company,Job Title,Phone,Street,City,State,Zip,Notes`
- Name split: first whitespace token → First Name; remainder → Last Name (`"Maria de la Cruz"` → `Maria` / `de la Cruz`); single token → First Name only.
- Phone: `phones[0]`; additional phones appended to Notes as `Other phones: …`.
- Address: full address string → Street; City/State/Zip left blank (honest v1 — no fragile address parsing).
- Notes: contact notes (+ other-phones line). Tags/status/next-step are CardCap-internal, not exported.
- All contacts exported, including ones without email; iContact's importer flags those rows visibly to the user.
- Standard CSV quoting (reuse existing CSV escaping in `exporters.ts`).

Route: `GET /api/export.icontact.csv` (auth-gated like the others). UI: one more button in the existing export row, labeled "iContact CSV".

### Frontend

- New `src/components/LoginGate.tsx`: email form + Turnstile widget + "Check your email" state. Includes: "Don't see it? Check spam/junk" hint, a Resend-link button (respects rate limit), and one privacy sentence ("Your contacts are private and yours — export or delete anytime").
- `App.tsx`: on load `GET /api/me`; 401 → render LoginGate; logged in → current app + signed-in email + Log out button. Quota 429 → friendly toast.
- No PWA-install promotion this release (iOS standalone cookie-jar risk with magic links).

### Error handling

| Case | Behavior |
|---|---|
| Turnstile fail | 400 "Verification failed, try again" |
| Rate-limited link request | 429 "Too many requests — wait a minute" |
| Resend API failure | 502 "Couldn't send the email — try again" |
| Expired/used link | Friendly HTML page + back-to-login |
| Quota hit | 429 toast, no spend incurred |

## Testing (vitest, pure functions)

- Token hashing + expiry decision logic
- Session cookie sign/verify (tamper, expiry, malformed)
- UTC-day quota window math
- `exportContactsIContactCsv`: header, name split cases, multi-phone, no-email row, CSV escaping
- Existing 6 suites keep passing

Worker-level flows verified by manual smoke per DEPLOYMENT.md.

## Deploy sequence

1. `npx wrangler d1 export cardcap-db --remote --output backup-2026-06-09.sql` (snapshot)
2. Wipe beta data: `npx wrangler d1 execute cardcap-db --remote --command "DELETE FROM extraction_jobs; DELETE FROM contacts; DELETE FROM users;"`
3. `npx wrangler d1 migrations apply cardcap-db --remote`
4. Create Turnstile site in Cloudflare dash → put `TURNSTILE_SITE_KEY` var + `TURNSTILE_SECRET_KEY` secret
5. `npx wrangler secret put SESSION_SECRET` (32+ random bytes), `RESEND_API_KEY`
6. Confirm `SENDER_EMAIL` domain is verified in Resend (DKIM/SPF green)
7. Delete `BETA_ACCESS_CODE` secret
8. `npm run build && npx wrangler deploy`, then smoke: health check, full login round-trip (incl. checking spam folder on a corporate-ish inbox), card upload, iContact CSV download

## Out of scope (explicitly deferred)

Stripe/billing · iContact live API push · MCP server · follow-up digest · share-hook footer on exports ("Get CardCap free") — first candidate after validation · PWA install flow · session revocation list

## Risks

1. **Corporate spam filters eat magic links** (top risk). Mitigations: Resend with verified DKIM domain, spam-folder hint + resend button in UI, admin backdoor via Cloudflare Access for rescue, CF Email Service swap path kept one-function wide.
2. Resend free tier = 3k emails/mo — far above expected volume; revisit at scale.
3. Stateless sessions can't be revoked per-user — accepted for a free v1; rotate secret in emergency.
