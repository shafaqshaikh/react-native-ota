# CLI Login + User Accounts — Design

**Date:** 2026-04-28
**Status:** Approved (brainstorming complete)
**Scope:** Single implementation plan
**Roadmap item:** #14 — CLI `login` command (interactive auth)

## 1. Problem

Today the CLI authenticates publishes via API keys passed through `--token`, `OTA_UPDATES_TOKEN` env, `.otaupdatesrc`, or the Expo plugin block. There is no concept of a user — every audit log entry records `actor: 'system'`, so the server cannot distinguish "Alice published a hotfix" from "the CI bot published the nightly". This is a production gap for incident response and a blocker for SOC2-style audit log export (roadmap item #22).

## 2. Goal

Add interactive, per-user authentication to the CLI. After `ota-updates login`, every CLI call carries a session token tied to a real user, and every server-side write is attributable. Existing API keys continue to work unchanged for CI/CD.

## 3. Decisions

1. **Auth model:** email + password, single global role. Any logged-in user can publish to any project. Per-project membership / roles are deferred.
2. **Bootstrap:** the existing `/admin` HTTP-Basic dashboard creates users (`POST /admin/users`). No env-seeded user. No self-registration.
3. **Coexistence with API keys:** API keys (`ota_live_*`) and session tokens (`ota_sess_*`) both work. Middleware dispatches by prefix. CI keeps using API keys; humans use sessions.
4. **Password creation:** admin types email + initial password directly when creating a user. No invitation token, no force-change-on-first-login. (Forced rotation is a follow-up.)
5. **Session TTL:** 30 days, no refresh-on-use. User logs in once a month per machine.
6. **Token storage on client:** `~/.config/ota-updates/credentials.json`, `0600`, plaintext token (same model as `~/.aws/credentials`).
7. **Project resolution for session-authed publishes:** API keys carry a project ID; sessions don't. The CLI must include `--project <slug>` (or read `defaultProject` from credentials), and the server validates the project exists.
8. **Hashing:** bcrypt (12 rounds) for passwords. SHA-256 for storing session tokens (mirrors how `ApiKey` already stores its keys).
9. **Token format:** `ota_sess_<32 hex>` so it's visually distinct from `ota_live_<32 hex>`.
10. **Rate limiting on `/v1/login`:** out of scope here. Roadmap item #3 lands a server-wide policy that will cover this endpoint.

## 4. Data Model

Two new Mongo collections in `server/src/db/mongo.js`.

### User

```js
{
  _id:           ObjectId,
  email:         String,    // unique, lowercased, trimmed
  passwordHash:  String,    // bcrypt, 12 rounds
  name:          String?,   // optional display name
  createdAt:     Date,
}
```

- Unique index on `email` (case-insensitive: store lowercased, query lowercased).

### Session

```js
{
  _id:         ObjectId,
  userId:      ObjectId,    // ref User
  tokenHash:   String,      // sha256(token), like ApiKey.keyHash
  expiresAt:   Date,        // = createdAt + 30 days
  createdAt:   Date,
  lastUsedAt:  Date,
  userAgent:   String?,     // populated from User-Agent on /v1/login (for the dashboard "active sessions" view)
}
```

- Index on `tokenHash` for lookups.
- TTL index on `expiresAt` (`expireAfterSeconds: 0`) so Mongo auto-prunes expired rows.

The plaintext token is returned **once** by `/v1/login` and is never persisted server-side in plaintext. Server-stored `tokenHash` cannot be reversed.

## 5. Server Endpoints

Three new public routes (mounted next to `/v1/check` and `/v1/manifest`).

| Method | Path           | Auth     | Purpose                                                                                            |
|--------|----------------|----------|----------------------------------------------------------------------------------------------------|
| POST   | `/v1/login`    | none     | Body `{ email, password }` → `{ token, user: { id, email, name }, expiresAt }`                     |
| POST   | `/v1/logout`   | session  | Deletes the current session row, returns `{ ok: true }`                                            |
| GET    | `/v1/me`       | session  | Returns `{ id, email, name, createdAt }`                                                           |

`/v1/login`:
1. Validates body (400 on missing/empty `email` or `password`).
2. Looks up `User` by lowercased email.
3. Constant-time `bcrypt.compare` against `passwordHash`. On failure (user missing OR wrong password) returns the same `401 { error: 'Invalid credentials' }` (no email-existence leak).
4. Generates `crypto.randomBytes(16).toString('hex')` → token = `ota_sess_<hex>`.
5. Inserts a `Session` row with `tokenHash = sha256(token)`, `expiresAt = now + 30d`, `userAgent = req.get('User-Agent')`.
6. Writes an AuditLog: `type: 'login'`, `actor: 'user:<email>'`, `payload: { sessionId }`.
7. Returns the plaintext token + user info.

`/v1/logout`: deletes `req.session`, writes AuditLog `type: 'logout'`, `actor: 'user:<email>'`, returns `{ ok: true }`.

`/v1/me`: returns the user fields.

## 6. Auth Middleware

`server/src/middleware/auth.js` gains a new `requireAuth` (the existing `requireApiKey` stays for backwards compatibility with existing routes that haven't been migrated yet):

```js
async function requireAuth(req, res, next) {
  const token = (req.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return res.status(401).json({ error: 'Missing credentials' });

  if (token.startsWith('ota_live_')) {
    return requireApiKey(req, res, next);  // sets req.apiKey, req.project
  }

  if (token.startsWith('ota_sess_')) {
    const session = await Session.findOne({ tokenHash: sha256(token) }).lean();
    if (!session || session.expiresAt < new Date()) {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }
    const user = await User.findById(session.userId).lean();
    if (!user) return res.status(401).json({ error: 'User not found' });
    req.user = user;
    req.session = session;
    Session.updateOne({ _id: session._id }, { lastUsedAt: new Date() }).catch(() => {});
    return next();
  }

  return res.status(401).json({ error: 'Invalid credentials' });
}
```

The `publish` route switches from `requireApiKey` to `requireAuth`. After the middleware, `req.apiKey` is set on the API-key path and `req.user` is set on the session path; the route handler treats them as alternatives.

The other API-key-authenticated routes — at the time of writing only `publish` is API-key-authenticated; `rollback` and `delete` already live on `/admin/*` behind HTTP Basic and are out of scope for this change.

For session-authed publishes, the route reads `req.body.projectSlug` (sent by the CLI as a multipart field) and resolves the project via `Project.findOne({ slug })`. If the project does not exist, returns 404. (Single-role: any logged-in user can publish to any project, so no per-user permission check.)

## 7. Admin Dashboard Changes

`server/src/routes/admin.js` gains three handlers + small HTML edits:

| Method | Path                            | Purpose                                                                            |
|--------|---------------------------------|------------------------------------------------------------------------------------|
| GET    | `/admin/users`                  | List users (id, email, name, createdAt, active session count). Renders an HTML table consistent with the existing `/admin/projects` page. |
| POST   | `/admin/users`                  | Form `{ email, password, name? }` → bcrypts password (rejects < 8 chars), inserts `User`, audits `user_created`, redirects back to `/admin/users`. |
| POST   | `/admin/users/:id/delete`       | Deletes the user, cascades all that user's `Session` rows, audits `user_deleted`, redirects back to `/admin/users`. |

The dashboard index gets a "Users" link in the nav. Optional follow-up: a `GET /admin/sessions?userId=<id>` view that lists active sessions with a "Revoke" button.

AuditLog actor populated as:
- `user_created` / `user_deleted` → `actor: '<basic-auth admin user>'` (from `req.headers.authorization` decoded user).
- `login` / `logout` → `actor: 'user:<email>'`.
- `publish` → `actor: 'user:<email>'` when session-authed, `actor: 'apikey:<keyId>'` when API-key-authed.
- `rollback` / `delete` continue to record the basic-auth admin user as the actor (unchanged — these routes are not migrated in this change).

## 8. CLI Changes

`cli/index.js` gets three new commands and a small auth helper.

```
ota-updates login                # interactive
ota-updates logout               # invalidates the local + server-side session
ota-updates whoami               # prints "<email> (logged in to <serverUrl>, expires <date>)"
```

Implementation notes:
- Add `prompts` (~5 KB, no transitive deps) for the interactive flow. `email` as a text prompt; `password` with `type: 'password'` so input is not echoed.
- `serverUrl` prompt defaults to `OTA_UPDATES_SERVER` env or the `.otaupdatesrc` `server` field if either is set.
- `login` writes `~/.config/ota-updates/credentials.json` (creates the directory with `0700`, file with `0600`):
  ```json
  {
    "serverUrl": "https://ota.example.com",
    "token": "ota_sess_...",
    "email": "alice@example.com",
    "expiresAt": "2026-05-28T12:34:56.000Z",
    "defaultProject": null
  }
  ```
- `logout` POSTs `/v1/logout` (best-effort; ignores 401 from already-expired tokens) and deletes the credentials file.
- `whoami` GETs `/v1/me`. On 401 it deletes the credentials file and prints `Session expired, run \`ota-updates login\``.
- The existing `publish` command gains a `--project <slug>` flag (already present on `check`). The flag is required when the resolved token is `ota_sess_*` and `defaultProject` is unset; ignored when the resolved token is `ota_live_*` (the API key carries its own project binding).
- `defaultProject` in `credentials.json` is `null` after `login`. There is no CLI command in v1 that sets it; users either pass `--project` per call or hand-edit the credentials file. A future `ota-updates use <slug>` command (out of scope) would set it.

### 8.1 Token resolution chain

`publish`, `check`, `list` resolve the bearer token in order, first match wins:

1. `--token` CLI flag
2. `OTA_UPDATES_TOKEN` env
3. `.otaupdatesrc` `token` (per-project, intended for CI checked into the repo)
4. `~/.config/ota-updates/credentials.json` `token` (per-user, interactive use)
5. Expo plugin block (`app.config.js` / `app.json`)

The same chain applies for `serverUrl`. If the resolved token starts with `ota_sess_` and `--project` is not set, `publish` falls back to `defaultProject` from credentials; if that is also unset, it errors with `--project required when using a session token`.

## 9. Error Handling

| Scenario                                  | Response                                                  | CLI behavior                                                                  |
|-------------------------------------------|-----------------------------------------------------------|-------------------------------------------------------------------------------|
| Wrong email or password                   | 401 `Invalid credentials`                                 | Prints same; non-zero exit                                                    |
| Malformed `/v1/login` body                | 400 with field name                                       | Prints, exits non-zero                                                        |
| `/me` or `/logout` with expired token     | 401                                                       | Deletes local credentials, prints "Session expired, run `ota-updates login`"  |
| Publish with expired session              | 401                                                       | Same — clears creds, exits, does *not* re-prompt mid-build                    |
| Admin create user: duplicate email        | 409 `Email already exists`                                | Dashboard re-renders the form with the message                                |
| Admin create user: password < 8 chars     | 400                                                       | Dashboard shows inline validation; CLI never sees this path                   |
| bcrypt / Mongo failure                    | 500 (logged via `console.error`)                          | CLI exits with the server's error message                                     |

The CLI never echoes the password and never logs the token in plaintext (uses `ota_sess_…redacted` in any log line that would otherwise contain it).

## 10. Testing

### 10.1 Server unit tests (`server/src/__tests__/`)

- `auth.endpoints.test.js`
  - Happy path: admin creates user → `/v1/login` succeeds → `/v1/me` returns user → `/v1/logout` 200 → `/v1/me` 401.
  - Wrong password → 401 `Invalid credentials` (same message as unknown email).
  - Expired session: insert a `Session` with `expiresAt` in the past → `/v1/me` returns 401.
  - bcrypt round-trip: hash, compare with right and wrong password.
- `auth.middleware.test.js`
  - `requireAuth` accepts a valid `ota_live_*` token (sets `req.apiKey`, `req.project`).
  - `requireAuth` accepts a valid `ota_sess_*` token (sets `req.user`, `req.session`).
  - Rejects unknown prefix, missing header, expired session.
- `users.schema.test.js`
  - Inserting two users with the same email (different cases) fails with the duplicate-key error.
  - The `Session` collection has the TTL index on `expiresAt`.

### 10.2 CLI unit tests

A single test for the resolver in `cli/index.js` (priority chain in §8.1): given a fixture filesystem and env, the resolver returns the expected token + serverUrl. No network, no prompts.

### 10.3 Manual E2E (post-implementation)

1. Boot a fresh server. Hit `/admin` with HTTP Basic, create user `alice@x.test` / `password123`.
2. From a clean shell run `ota-updates login` → enter creds → see `Logged in as alice@x.test`.
3. `ota-updates whoami` prints email + serverUrl + expiry.
4. `ota-updates publish --platform ios --project <slug>` succeeds. The new AuditLog row has `actor: 'user:alice@x.test'`.
5. `ota-updates logout` → credentials file is gone → next `whoami` prints `Not logged in`.
6. Set `Session.expiresAt` to a past date in Mongo → next CLI call prints `Session expired, run \`ota-updates login\`` and clears the credentials file.

## 11. Out of Scope (follow-ups)

- Per-project membership / roles — the multi-tenant Expo team model.
- Password reset flow (email-based or admin-triggered link).
- Force password change on first login.
- MFA / 2FA.
- OAuth / SSO (Google, GitHub) for `ota-updates login`.
- Rate limiting on `/v1/login` — covered by roadmap item #3.
- A "revoke session" button in the admin dashboard (`GET /admin/sessions?userId=…`) — flagged as optional in §7.
- Replacing the existing HTTP Basic admin auth with the new user model (admins remain a separate concept until a roles model lands).
