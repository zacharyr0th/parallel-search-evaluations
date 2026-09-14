# HTTP API contract

Use this reference when changing a route under `app/api` or its caller. It defines requests,
responses, errors, and limits.

The API serves this application’s browser client. Update routes and callers together; they
deploy together without API version negotiation or a compatibility window.

## Routes

| Route | Methods | Purpose |
| --- | --- | --- |
| `/api/<operation>` | `GET`, `POST` | Evaluations, grading, and activity. Operations are listed below. |
| `/api/credits` | `GET` | The Parallel account credit balance. |
| `/api/auth/<endpoint>` | `GET`, `POST` | Proxy for the five Better Auth endpoints the sign-in page uses. |

A path outside these three is not served. An unknown operation or auth endpoint returns `404`. An unsupported method on a known endpoint
returns `405` with an `Allow` header listing the supported methods.

## Authentication and authorization

Every route authorizes on the server before doing any work. `accessContext` resolves the signed-in
reviewer and returns one of:

| Status | Code | Meaning |
| --- | --- | --- |
| `200` | — | Signed in and on the allowlist. `actor` is the reviewer's verified email. |
| `401` | `authentication_required` | No session. |
| `403` | `account_not_permitted` | Signed in, but the address is not on the allowlist. |
| `503` | `sign_in_unavailable` | The sign-in service is unavailable. |

The reviewer identity attached to a rating is always the server's `actor`. A caller cannot supply
or override it.

Two further checks apply to writes on `/api/<operation>`:

1. Outside Vercel, the request `Host` must be the local application address, or the response is
   `403 local_address_required`.
2. `Origin` must equal the application origin and `X-Requested-With` must be `SearchEvaluations`,
   or the response is `403 stale_client`. This keeps writes to the application's own browser
   bridge; it is not a substitute for the session check above.

## Request rules

- Writes must send `Content-Type: application/json` (`415 unsupported_media_type`) and a JSON
  object, not an array or `null` (`400 invalid_body`).
- The request body is bounded while it streams, before it is buffered: 128 KiB on
  `/api/<operation>` and 8 KiB on `/api/auth`, then `413 payload_too_large`. `Content-Length` is
  not trusted, because it can be omitted or forged.
- Unrecognized top-level keys in a write payload are **ignored**. The one exception is
  `search_request` and its nested objects. Their closed schema rejects unsupported fields.
  These settings go to the Parallel Search API; ignoring a field would change the configured comparison.
- `X-Request-Id` is accepted when it matches `^[\w.:-]{1,128}$` and is replaced by a generated
  UUID otherwise. It correlates one request across logs and nothing else: it is never treated as
  authentication, authorization, freshness, or an idempotency key.

## Response and error shape

Success bodies are operation-specific and described below. Every failure on `/api/<operation>` and
`/api/credits` uses one shape:

```json
{ "code": "stale_result_version", "error": "Result changed. Reload before saving.", "trace": "…" }
```

- `code` is a stable machine-readable identifier. Branch on it, never on `error`.
- `error` is reviewer-facing prose, already safe to display. It never carries a stack trace, a
  credential, a database message or another reviewer's data.
- `trace` repeats the `X-Request-Id` of the same response.

`/api/auth` failures use `{code, message, trace}` instead. `message` is Better Auth's own
convention and its client library reads that key; matching it avoids inventing a second shape for
the same purpose.

Every response carries `X-Request-Id`.

### Codes

| Code | Status | Condition |
| --- | --- | --- |
| `unknown_operation`, `unknown_endpoint` | 404 | The operation or endpoint is not served. |
| `method_not_allowed` | 405 | Known operation, wrong method. `Allow` names the right one. |
| `authentication_required` | 401 | No session. |
| `account_not_permitted`, `email_not_permitted` | 403 | The address is not on the allowlist. |
| `local_address_required`, `stale_client`, `invalid_origin` | 403 | The request did not come through the application's own bridge. |
| `unsupported_media_type` | 415 | A write was not `application/json`. |
| `invalid_json`, `invalid_body`, `invalid_request` | 400 | The body did not parse, or failed validation. |
| `invalid_idempotency_key` | 400 | `idempotency_key` is not a UUID. |
| `payload_too_large` | 413 | The body exceeded the route's cap. |
| `evaluation_not_found`, `result_not_found`, `not_found` | 404 | The named evaluation or result does not exist. |
| `stale_result_version` | 409 | The result changed since the caller read it. Refetch and reapply. |
| `idempotency_key_conflict` | 409 | The key was already used for a different search. |
| `concurrent_run_write` | 409 | Another writer already stored this run. |
| `daily_search_limit`, `rate_limited` | 429 | The daily search limit was reached. `Retry-After` gives seconds until reset. |
| `balance_unavailable`, `upstream_unavailable` | 502 | A dependency failed or returned an invalid response. |
| `database_not_configured`, `database_unavailable`, `search_not_configured`, `account_authorization_unavailable`, `sign_in_unavailable`, `service_unavailable` | 503 | A dependency is missing or unreachable. Retrying may succeed. |

A backend failure that carries no code of its own maps by status: 400 `invalid_request`,
404 `not_found`, 409 `conflict`, 429 `rate_limited`, 502 `upstream_unavailable`,
503 `service_unavailable`. An unexpected exception becomes `502 upstream_unavailable` and its
message is never echoed to the caller.

## Reads

All reads are `GET /api/<operation>`, with the evaluation named by `?id=`.

| Operation | Returns | Caching |
| --- | --- | --- |
| `evaluations` | Up to 100 evaluation summaries, newest first. | `private, no-cache`, `Vary: Cookie`, `ETag` |
| `evaluation` | One evaluation with its merged grading history. | `private, no-cache`, `Vary: Cookie`, `ETag` |
| `export` | The same evaluation, plus `exported_at`, with the full grading audit trail. | `no-store` |
| `activity` | Up to 100 activity events, oldest first. | `no-store` |
| `agreement` | Inter-reviewer agreement metrics for the evaluation. | `no-store` |

`evaluations` and `evaluation` support conditional requests. The `ETag` is computed over the deployment
revision, the reviewer, the operation, the ID, and the stored row versions, so it never lets one
reviewer's response serve another. A matching `If-None-Match` returns `304` without loading the
evaluation, but still requires a valid session first.

`evaluations` and `activity` are capped rather than paginated. Both report the cap and whether the
page hit it, so a caller can tell a complete list from a truncated one:

```
X-Items-Limit: 100
X-Items-Truncated: true
```

A blinded evaluation that is not yet revealed reports each run's mode as its label, reports
`elapsed` as `null`, drops the per-run provider request and response, and returns only the first
five results. This holds on `export` too.

## Writes

### `POST /api/search`

Runs one or two Parallel Search calls and stores the result as a new evaluation. This is the only
operation that spends money.

| Field | Ownership | Behavior |
| --- | --- | --- |
| `modes` | required | 1–2 of `turbo`, `fast`, `basic`, `advanced`. |
| `query` or `search_request` | required | `query` is 1–200 characters. `search_request` is the closed Search API schema: 1–5 queries, objective ≤ 5,000 characters, ≤ 200 source entries. |
| `requests` | optional | One full request per mode, for a per-mode comparison. Each must share the queries and objective of `search_request`. |
| `criteria` | optional | Reviewer criteria, ≤ 2,000 characters. Defaults to empty. |
| `blind` | optional | `true` hides mode identity until review completes. Requires exactly two modes. |
| `idempotency_key` | optional | A UUID. See retries below. |
| everything else | server-set | `id`, `created_at`, `rubric`, result IDs, ranks, and versions. |

The daily budget is reserved before the provider is called and released if the evaluation cannot
be stored. Each mode's results are written independently as it finishes, so a two-mode search that
loses one mode still stores the other with its error recorded on that run.

### `POST /api/feedback`

Records one reviewer's grade for one result.

| Field | Ownership | Behavior |
| --- | --- | --- |
| `result_id` | required | Safe integer. |
| `version` | required | The result version the caller last read. A mismatch is `409 stale_result_version`. |
| `relevance` | required key | Integer 0–3, or `null` to clear the rating. The key must be present; omitting it is `400`. |
| `issues` | required | Array of unique tags from the six defined tags. `[]` means no issues. |
| `notes` | optional | **Omitted preserves the stored note. Present replaces it**, trimmed, ≤ 2,000 characters. |
| `evaluation_id` | optional | Skips the lookup by result id. |
| `actor`, `rubric_version`, `updated_at` | server-set | A caller cannot set these. |

The response returns the stored result and its new `version`, which is the caller's `version` plus
one. Use that value on the next save.

### `POST /api/activity`

Appends 1–20 UI events to an evaluation's timeline. Each event needs a caller-generated UUID `id`,
an `action` of `opened` or `clicked`, and a `target` of 1–200 characters. Events are deduplicated
by `id`, so resending a batch records nothing twice.

## Retries and idempotency

- Reads are safe to retry.
- `POST /api/activity` is idempotent by event `id`.
- `POST /api/feedback` is guarded by `version`. A retry that already succeeded is rejected as
  `409 stale_result_version` rather than applied twice; refetch the result and reapply.
- `POST /api/search` is **not** naturally idempotent and spends Parallel credits, so it accepts an
  `idempotency_key`. The key becomes the evaluation id. A repeated submission with the same key
  returns the original evaluation without searching again, and two identical submissions that race
  resolve to one search, because the loser's insert conflicts on that id. Reusing one key for
  different search settings is `409 idempotency_key_conflict`, and does not run a new search. Without a key,
  a retry creates a second evaluation and spends credits again.

An accepted search continues after a timeout or disconnect and saves its results when it finishes. Because the caller chose the key, it can read that
evaluation by id afterwards instead of resubmitting.

## Concurrency and consistency

Ratings are written with one SQL statement that rewrites only the graded result and guards on that
result's own version. Two reviewers grading different results in one evaluation never conflict;
if two reviewers save the same result version, the second save returns `409 stale_result_version`.
The first save remains stored. Nothing is silently overwritten.

Reads are read-after-write for the writer: a rating's response reflects the committed row, and the
blind-reveal check runs in SQL against the document Postgres just wrote rather than against a copy
already read. Grading history merges `evaluation_feedback` with the in-document trail that
evaluations saved before that table still carry, so no history is lost or double-counted.

## Limits

| Limit | Value |
| --- | --- |
| Request body | 128 KiB on `/api/<operation>`, 8 KiB on `/api/auth` |
| `/api/<operation>` route deadline | 120 s |
| One Parallel Search call | 90 s |
| Account balance call | 10 s |
| Database call | 15 s |
| Search calls per day, workspace-wide | 100 |
| Evaluations per `evaluations` read | 100 |
| Events per `activity` read | 100 |
| Grading events per `evaluation` read | 2,000 |
| Activity events per write | 20 |

## Identifiers and quantities

- Evaluation, run, and activity IDs are UUIDs. Result ids are 48-bit integers, within the
  JavaScript safe-integer range and validated as safe integers on the way in.
- Timestamps are ISO 8601 with an offset, generated server-side.
- `elapsed` is seconds as a decimal. `relevance` is an integer 0–3. `coverage` and `useful_at_5`
  are fractions of one; `rank_score_at_5` is 0–100.
- `/api/credits` reports `balanceCents` as an integer number of cents, never a float, alongside
  `currency`. The upstream balance endpoint returns no currency field, so `currency: "USD"` is
  this contract's stated assumption rather than an upstream value. It is named here so callers do
  not each assume one.
- `/api/credits` separates an ordinary empty state from a failure. No connected Parallel account
  is `200` with `{available: false, reason_code: "account_not_connected"}`. A dependency that
  cannot answer is `503 account_authorization_unavailable` or `502 balance_unavailable`.

## Known limits

The API has these limits:

1. **No cursor pagination.** `evaluations` and `activity` cap and signal truncation instead. Older
   evaluations past 100 are not reachable through the API.
2. **The daily search budget is workspace-wide.** One reviewer can spend the whole cap. There is
   no per-reviewer allocation.
3. **No cancellation.** Disconnecting does not stop an in-flight Parallel search; the deadlines
   above bound it instead.
4. **Partial two-mode failures are reported per run, not per request.** A run whose write loses a
   race fails the whole request with `409 concurrent_run_write` even though the other run's
   results are already stored. The caller must reload the evaluation to see which results were saved.
5. **Grading history ties are unordered.** The merged timeline breaks ties on `version`, which is
   unique per result but not across results, so two events sharing a timestamp and version have no
   defined order.
6. **No deprecation or sunset notices.** There is one client, deployed with the routes, so
   routes are removed rather than deprecated.
