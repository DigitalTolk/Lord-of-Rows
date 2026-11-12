# Access API

The **Access API** is the HTTP protocol Lord of the Rows speaks to an access-management
service: a server where developers request time-limited access to a database, an
approver decides, the server provisions a personal database user, and the app turns
the grant into a saved connection. Any service that implements the endpoints below
works with the app's **Access API** provider type (kind id `access-api`).

This document describes the protocol exactly as the client in
`crates/dbs-access/src/providers/access_api/` implements it: what the app sends, which
response fields it reads, and what it does with each answer. Fields not listed here
are ignored; missing fields fall back to the defaults given (empty string, `0`,
`false`, empty list), so a server may send more than described.

All examples use `https://access.example.com` as the provider base URL.

## Contents

1. [Conventions](#1-conventions)
2. [Sign-in](#2-sign-in)
3. [Users](#3-users)
4. [Services (databases)](#4-services-databases)
5. [Access requests](#5-access-requests)
6. [Approvals](#6-approvals)
7. [Credentials](#7-credentials)
8. [Status mapping](#8-status-mapping)
9. [Drivers, engines and environments](#9-drivers-engines-and-environments)
10. [Errors](#10-errors)
11. [Optional features and capability detection](#11-optional-features-and-capability-detection)
12. [Linking to the app](#12-linking-to-the-app)
13. [Deploying the provider to a team](#13-deploying-the-provider-to-a-team)

## 1. Conventions

- **Base URL.** The user (or a managed `providers.json`) configures the provider's base
  URL, e.g. `https://access.example.com`. The app normalises it: no trailing slash, no
  credentials, query or fragment, and a pasted `…/api/v1` suffix is dropped. `https://`
  is required; plain `http://` is accepted only for a server on the same machine
  (`localhost`, `127.0.0.1`, `::1`), so a session token never crosses the network in
  clear text.
- **Paths.** Every endpoint lives under `<base URL>/api/v1`. Paths below are relative to
  that prefix.
- **JSON.** Request and response bodies are JSON (`content-type: application/json`)
  with **camelCase** field names. Every request carries `accept: application/json`.
  An empty 2xx body is read as `null`.
- **Authentication.** After sign-in, every request carries
  `authorization: Bearer <token>`.
- **User agent.** `LordOfTheRows/<app version>`.
- **Redirects** are never followed (the token is only ever sent to the configured
  server). A 3xx answer to an API call is treated as an error.
- **Timeouts.** 8 s to connect, 20 s per request. A connection failure or timeout is
  reported to the user as *"Can't reach the access provider at {host} (…). Are you on
  the VPN?"* and does **not** sign the user out.
- **Identifiers** (`requestId`, `serviceId`, `credentialId`) that the app puts into a
  path or query must be 1–128 characters of `A–Z a–z 0–9 - _`. The app refuses other
  ids before sending anything.
- **Timestamps.** `expiresAt` fields are Unix seconds (`0` = not set). Other times
  (`createdAt`, `reviewedAt`) are ISO-8601 strings shown as given.

## 2. Sign-in

Sign-in is a browser flow (whatever single sign-on the server uses) handed back to the
desktop app through a loopback redirect with PKCE (RFC 7636 / RFC 8252 style).

### 2.1 `GET /api/v1/auth/desktop/start`

The app binds `127.0.0.1:<random port>`, then opens this URL **in the user's browser**:

```
https://access.example.com/api/v1/auth/desktop/start
  ?redirect_uri=http%3A%2F%2F127.0.0.1%3A53123%2Fcallback
  &state=<random, URL-safe>
  &code_challenge=<BASE64URL(SHA-256(code_verifier)), 43 chars>
  &code_challenge_method=S256
  &device_name=Lord%20of%20the%20Rows%20on%20<computer name>
```

| Parameter | Meaning |
|---|---|
| `redirect_uri` | Always `http://127.0.0.1:<port>/callback`. The server should accept only loopback redirect URIs of this shape. |
| `state` | Opaque value; must be returned unchanged. |
| `code_challenge`, `code_challenge_method` | PKCE; the method is always `S256`. |
| `device_name` | Human-readable label for the session (e.g. for a "your sessions" list). |

The server authenticates the user however it likes, then redirects the browser to:

```
http://127.0.0.1:<port>/callback?code=<one-time code>&state=<state>
```

On failure it may redirect with `?error=<code>&error_description=<text>&state=<state>`
instead; the app shows *"Sign-in failed: <description>"*. A wrong `state`, a missing
`code` or a code over 2048 characters fails the attempt. The app waits up to
5 minutes for the browser to come back; the user can cancel at any time.

### 2.2 `POST /api/v1/auth/desktop/token`

Exchanges the code for a desktop session token. Request body (snake_case, as in OAuth):

```json
{ "code": "…", "code_verifier": "…", "redirect_uri": "http://127.0.0.1:53123/callback" }
```

The server must check that `SHA-256(code_verifier)` matches the challenge it saw and
that `redirect_uri` is the one from the start request. Codes should be single-use and
short-lived.

Response `200`:

```json
{
  "token": "…",
  "tokenId": "t1",
  "expiresAt": 4102444800,
  "user": { "userId": "u1", "email": "dev@example.com", "name": "Dev", "role": "developer", "managerId": "m1" }
}
```

| Field | Used for |
|---|---|
| `token` (required) | Bearer token for all later calls. Stored only in the OS keychain. |
| `tokenId` | Informational. |
| `expiresAt` | Session expiry (Unix seconds); `0` or absent = no known expiry. |
| `user` | See [Users](#3-users). |

### 2.3 `POST /api/v1/auth/logout`

Sent with the bearer token when the user signs out or removes the provider. The body
is ignored; any 2xx is fine. This call is best effort: the app forgets the token
locally right away and sends the logout in the background with a short timeout, so a
slow or unreachable server never blocks the UI.

### 2.4 `GET /api/v1/auth/me`

Checks the session and returns the user. Response `200`:

```json
{ "user": { "userId": "u1", "email": "dev@example.com", "name": "Dev", "role": "manager", "managerId": "m1" } }
```

Other fields in the response (e.g. a CSRF token for the web UI) are ignored. A `401`
means the session ended: the app forgets the token and shows "signed out". Any other
failure (unreachable, 5xx) keeps the user signed in with a warning.

## 3. Users

| Field | Meaning in the app |
|---|---|
| `userId` | Requester id. |
| `email`, `name` | Shown in the Access panel. |
| `role` | `developer`, `manager` or `admin`. `manager` and `admin` are **approvers**: the app shows them the Approvals inbox. |
| `managerId` | Who approves this user's requests. A `developer` with an empty or missing `managerId` can't file requests (nobody could approve them): the app disables the request form and explains why. |

## 4. Services (databases)

### 4.1 `GET /api/v1/services`

The catalog of services the user may request. Response `200`:

```json
{
  "items": [
    {
      "serviceId": "s1",
      "name": "orders",
      "environmentId": "e1",
      "environmentName": "staging",
      "driverKey": "rds-postgres",
      "region": "eu-central-1",
      "isActive": true,
      "config": { "endpoint": "orders.db.example.com", "port": 5432, "engine": "postgres" }
    }
  ],
  "total": 1
}
```

The app reads `items` from this single response (no paging), so the server should
return the whole catalog. Only services with `isActive: true` and a `driverKey` the app
can connect to (see [Drivers](#9-drivers-engines-and-environments)) are offered; the
rest are hidden. From `config` it reads:

| Key | Meaning |
|---|---|
| `endpoint` (or `host`) | Database host, shown in the picker. |
| `port` | Number or numeric string. |
| `engine` | Engine string; tells MariaDB from MySQL. |

The picker groups services by `environmentName` and sorts by environment, then name.

### 4.2 `GET /api/v1/services/{serviceId}/targets`

Optional. Lists the databases a request on this service can target, so the user can
pick them instead of typing names. Response `200`:

```json
{ "ok": true, "targets": ["app", "audit"] }
```

or, when the server could not list them:

```json
{ "ok": false, "error": "connection refused" }
```

Any failure here is soft: `ok: false`, a `503` (no target lister configured) or any
other error (except `401` and unreachable) shows the message and lets the user type
database names by hand.

## 5. Access requests

### 5.1 Request object

Every endpoint that returns a request uses this shape (all fields optional except
`requestId`):

| Field | Type | Meaning |
|---|---|---|
| `requestId` | string | Id. |
| `userId` | string | Requester id. |
| `serviceInstanceId` | string | The service requested. |
| `status` | string | Lifecycle: `pending`, `approved`, `rejected`, `expired`, `revoked`. |
| `provisioningStatus` | string | After approval: `""`, `queued`, `provisioned`, `failed`. |
| `provisioningError` | string | Shown when provisioning failed. |
| `provisioningLog` | `[{ "ts", "level", "msg" }]` | Shown live while provisioning (may be omitted from list responses). |
| `requestType` | string | Always `developer` for requests the app creates. |
| `accessType` | string | `read` or `read_write`. |
| `reason` | string | Free text; may carry a ticket prefix (see 5.2). |
| `targetDatabases` | string[] | Databases requested. |
| `database` | string | Fallback when `targetDatabases` is empty: comma-separated database names. |
| `createDatabase` | bool | The server should create the (single) target database when provisioning. |
| `rejectReason` | string | Shown for rejected requests. |
| `reviewedAt` | string | When the request was decided. |
| `accessTtlHours` | number | Approved lifetime in hours (`0` = unknown). |
| `expiresAt` | number | Unix seconds when access ends (`0` = not set). |
| `createdAt` | string | Shown as the request time. |
| `serviceName`, `environmentName` | string | Shown on the request; the environment name also sets the connection's environment colour. |
| `driverKey`, `engine` | string | Database engine of the service (see section 9). |
| `endpoint`, `port` | string, number | Host and port the connection opens (required to connect). |
| `requesterName`, `requesterEmail` | string | Shown to approvers. |
| `managerName`, `managerEmail` | string | Shown as "waiting for …" while pending. |
| `approverName`, `approverEmail` | string | Shown as the decider once decided. |
| `provider` | string | Informational. |

### 5.2 `POST /api/v1/requests`

Creates a request. Body:

```json
{
  "serviceInstanceId": "s1",
  "accessType": "read",
  "reason": "[OPS-123] Investigate the failed invoice export",
  "requestType": "developer",
  "targetDatabases": ["app"],
  "createDatabase": true
}
```

- `accessType`: `read` (read-only) or `read_write` (read & write).
- `targetDatabases`: 1–100 names, trimmed.
- `createDatabase` is sent only when `true`; then exactly one target name of letters,
  digits and underscores (up to 64) is sent.
- `reason`: 1–2000 characters, trimmed.
- **Ticket prefix.** The protocol has no ticket field. When the user gives a ticket
  reference, the app sends it as a prefix of the reason: `"[" + ticket + "] " + reason`.
  A ticket is 1–40 characters of `A–Z a–z 0–9 - _ . # /`. When reading any request,
  a reason that starts with `[<valid ticket>]` is shown as that ticket plus the rest of
  the reason; anything else is shown unchanged.

Response `200`/`201`: the new request object. A `409` (e.g. "a pending request for this
service already exists") is shown to the user as is.

### 5.3 `GET /api/v1/requests`

The signed-in user's requests, newest first. Response: a JSON array of request objects
(`null` is read as an empty list). Provisioning logs may be omitted here. The app polls
this list while the Access panel is open and while requests are in flight.

### 5.4 `GET /api/v1/requests/{requestId}`

One request including `provisioningLog`. Used for the request detail, before
connecting, to follow a deep-linked request, and to check whether saved connections
created from a request are still valid.

### 5.5 `POST /api/v1/requests/{requestId}/revoke`

Cancels a pending request, or gives up approved access early. No body. Response: the
request object. Whatever the response's status, the app treats the request as ended
afterwards and wipes the saved password of a connection created from it.

## 6. Approvals

Shown to users whose `role` is `manager` or `admin`.

### 6.1 `GET /api/v1/approvals`

Requests waiting for the signed-in approver. Response: a JSON array of request objects
(`null` = empty).

### 6.2 `POST /api/v1/requests/{requestId}/approve`

No body. Response: the request object. After approval the server is expected to set
`status: "approved"` and move `provisioningStatus` through `queued` to `provisioned`
(or `failed`), and set `expiresAt`.

### 6.3 `POST /api/v1/requests/{requestId}/reject`

Body `{ "reason": "…" }` (1–2000 characters; the app requires one). Response: the
request object.

### 6.4 `GET /api/v1/approvals/decided?limit={n}[&cursor={c}]` (optional)

Requests the signed-in approver has decided, newest decision first, for the **Decided**
tab. `limit` is 1–100 (the app asks for 50); `cursor` is the `next` value of the
previous page (up to 1024 characters, no control characters).

```json
{ "items": [ { "requestId": "d1", "status": "rejected", "rejectReason": "not now", "reviewedAt": "2027-01-01T10:00:00Z", "requesterName": "Robin" } ], "next": "c2" }
```

`next` is `null`, absent or `""` on the last page. A server without this endpoint
answers `404`; the app then hides the Decided tab for that provider (see section 11).

## 7. Credentials

Credentials are fetched only when the user clicks **Connect** on a ready request.

### 7.1 `GET /api/v1/credentials?requestId={requestId}`

Credentials issued for the request that the signed-in user may see. Response: a JSON
array (`null` = empty):

```json
[
  {
    "credentialId": "c1",
    "accessRequestId": "r1",
    "username": "dev_r1",
    "credentialType": "db_password",
    "status": "active",
    "viewCount": 1,
    "maxViews": 5,
    "expiresAt": 4102444800
  }
]
```

The app uses the first credential with `credentialType: "db_password"` and
`status: "active"` (other types are ignored). `maxViews` is the reveal budget
(`0` = unlimited); the reveals left are `maxViews - viewCount`. With none left the app
says *"No password reveals are left for this request. Request access again."* without
calling reveal. `expiresAt` is used as the connection's expiry when the request has
none. Listing never spends a reveal.

### 7.2 `POST /api/v1/credentials/{credentialId}/reveal`

Returns the password and spends one reveal. No body. Response `200`:

```json
{ "password": "…", "revealsRemaining": 4 }
```

`revealsRemaining` ≥ 2147483647 means unlimited. A `429` means the budget is used up.
The app reveals **at most once** per connection: the password goes straight into the OS
keychain and later connects reuse it. When the access ends (expiry, revoke, reject)
the app wipes it and marks the connection *Expired — request again*.

## 8. Status mapping

The app collapses `status` + `provisioningStatus` into one neutral `RequestStatus`
(`now` = current time):

| `status` | `provisioningStatus` | Other | App status |
|---|---|---|---|
| `pending` | any | | `pending` (waiting for approval) |
| `approved` | `""`, `queued`, anything else | | `provisioning` (live log shown) |
| `approved` | `failed` | | `failed` (shows `provisioningError`) |
| `approved` | `provisioned` | `expiresAt` = 0 or > now | `ready` (Connect enabled) |
| `approved` | `provisioned` | 0 < `expiresAt` ≤ now | `expired` |
| `rejected` | any | | `rejected` (shows `rejectReason`) |
| `expired` | any | | `expired` |
| `revoked` | any | | `revoked` |
| anything else | | | `pending` |

Connect is refused with a clear message unless the status is `ready`. A request is
**ended** (its saved password is wiped) when the status is `expired`, `revoked` or
`rejected`, or it is `approved` with 0 < `expiresAt` ≤ now. The app warns 15 minutes
before `expiresAt`.

Approver shown on a request: `managerName`/`managerEmail` while pending,
`approverName`/`approverEmail` afterwards.

## 9. Drivers, engines and environments

### Engines

| `driverKey` | `engine` | App engine |
|---|---|---|
| `rds-postgres`, `onprem-postgres` | any | PostgreSQL |
| `rds-mysql`, `onprem-mysql` | contains `maria` (case-insensitive), e.g. `mariadb`, `10.11.6-MariaDB` | MariaDB |
| `rds-mysql`, `onprem-mysql` | anything else (`mysql`, `aurora-mysql`, empty) | MySQL |
| anything else | | not supported: hidden from the picker, Connect refused |

For services the engine comes from `config.engine`; for requests from the `engine`
field.

### TLS

- `driverKey` starting with `rds-`: TLS **required** without CA chain verification
  (managed cloud database CAs are usually not in the OS trust store).
- Any driver in a production environment: TLS **required**.
- Otherwise: TLS **preferred**.

### Environments

`environmentName` is matched case-insensitively (in this order) to the app's
environment kinds, which set the connection's colour and safety rules:

| Name contains | Kind |
|---|---|
| `preprod`, `pre-prod`, `stag`, or the word `uat` | Staging |
| `prod`, or the word `prd` or `live` | Production |
| `test`, or the word `qa` | Testing |
| `dev` | Development |
| `local` | Local |
| anything else | Custom |

### Access types

| Wire `accessType` | App |
|---|---|
| `read` | Read-only (the saved connection is also marked read-only) |
| `read_write` | Read & write |

### The saved connection

Name `"<serviceName> · <first target database>"` (or the engine name when no database is
known), host `endpoint`, `port` (the engine's default port when `0` or missing), database = first
of `targetDatabases` (or of `database`), user = the credential's `username`.

## 10. Errors

Error responses should carry `{"error": "<message>"}`. The message (control characters
removed, at most 500 characters) is shown to the user; otherwise a generic text is
used.

| HTTP status | App behaviour |
|---|---|
| `400`, `422` | Invalid input: shows the message (default *"the access provider rejected the request"*). |
| `401` | Session ended: the token is forgotten and the user is shown as signed out. |
| `403` | Not allowed: shows the message (default *"the access provider does not allow this action for your account"*). |
| `404` | Not found (default *"not found at the access provider"*); on `/approvals/decided` it means "not supported". |
| `409` | Conflict with the current state (e.g. a duplicate pending request): shows the message. |
| `429` | On reveal: no reveals left. |
| `5xx` and anything else | *"access provider error (HTTP n): <message>"*. The user stays signed in. |
| no answer / timeout | *"Can't reach the access provider at {host} … Are you on the VPN?"*. The user stays signed in. |

Only `401` ever signs the user out.

## 11. Optional features and capability detection

The app assumes an Access API server supports approvals, creating a database at
provisioning time (`createDatabase`), cancelling requests and the target lister.
Two parts degrade gracefully when missing:

- **Target lister** (`GET /services/{id}/targets`): any failure falls back to typing
  database names.
- **Decision history** (`GET /approvals/decided`): a `404` hides the Decided tab for
  that provider.

The Approvals inbox is shown only to users whose `role` is `manager` or `admin`.

## 12. Linking to the app

A server can link straight into the app (for example from a notification e-mail or its
web UI) with the `lordoftherows://` URL scheme:

```
lordoftherows://access?provider=<URL-encoded base URL>[&request=<requestId>][&kind=access-api]
```

| Parameter | Meaning |
|---|---|
| `provider` (required) | The provider base URL, URL-encoded; same rules as in section 1. |
| `request` | A request id to open once signed in. |
| `kind` | Provider type; defaults to the only (first) registered type. |

Example: `lordoftherows://access?provider=https%3A%2F%2Faccess.example.com&request=req-42`

The app opens the Access view on the matching provider. A provider that is not set up
yet is added only after the user confirms. Links never connect to a database or reveal
a password by themselves.

## 13. Deploying the provider to a team

An organisation can preconfigure providers with a `providers.json` file (see the
README's *Access requests* section for its locations):

```json
[{ "kind": "access-api", "name": "Company access", "url": "https://access.example.com" }]
```

Providers listed there appear as *Managed by your organization* and can't be edited or
removed in the app.
