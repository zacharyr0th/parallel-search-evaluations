# Vercel deployment

The Next.js app calls Parallel from server routes and saves evaluations in Neon Postgres. Neon Auth provides managed Better Auth with Google sign-in and email verification codes.

Access requires a verified `@parallel.ai` email address or the verified owner address, `eas.vone@gmail.com`. The page proxy and evaluation API both enforce this rule. Users share evaluation data; this application does not isolate evaluations by account. The workspace permits 100 Search API calls per UTC day. A two-mode comparison consumes two calls.

Vercel requires these server-only production environment variables:

- `PARALLEL_API_KEY`
- `DATABASE_URL`
- `NEON_AUTH_BASE_URL`
- `NEON_AUTH_COOKIE_SECRET` (at least 32 random characters)

Keep secrets in sensitive environment variables. Never use a `NEXT_PUBLIC_` prefix. Local Next.js development also requires Neon Auth configuration. Neon permits localhost redirects; production uses `https://parallel-search-evaluations.vercel.app` as its trusted origin.

Session cookies use the SDK's signed cache with a 60-second lifetime. Email ownership is checked through `emailVerified`; matching an entered email address is insufficient. Auth errors deny access. The application auth proxy exposes only session, sign-out, Google sign-in, and email-code endpoints. Writes require a matching Origin. Account creation through password endpoints is not exposed by the application.

Local and deployed instances use the database configured by `DATABASE_URL`. Saved evaluations contain result snapshots and feedback history. Each result carries its own version, so concurrent edits to the same result require the reviewer to reload before saving. Each completed search mode saves independently. Reopen saved evaluations after a timeout before retrying a search.

Run `node tests/backend.mjs` for the email access policy. Run `npm run build && npm run test:built` to check sign-in against a local production build; it starts and stops its own server. Set `AUTH_TEST_URL` to check a deployed instance instead. These checks do not complete Google sign-in or send verification emails. Complete one real sign-in before claiming the authenticated workflow is verified.

Run `python3 tests/cloud.py BASE_URL COOKIE_FILE` with a private file containing the Cookie header from an authenticated browser to test live search and persistence. This consumes two Search API calls and leaves a deployment-check evaluation. Never commit the cookie file.

After deployment approval, link the directory with `vercel link --scope raintree-technology`; the local `.vercel/`
link is not committed. Then deploy with `vercel deploy --prod --scope raintree-technology`
from this directory. Database compute suspends after five idle minutes.

## App activity

Apply `schema.sql` before deploying updates. The verified owner can open **App activity** from the account menu at `/activity`. The API returns the latest 200 events and refuses other accounts.

The log records anonymous sign-in starts and failures, verified session access, workspace access, completed comparison requests, and saved feedback. Verified session access and workspace access appear once per session. A session first seen after deployment also appears as a successful sign-in. Closing Google's sign-in window without returning does not produce a failure event. Feedback includes grades, tags, and notes; their contents are not copied into this log. Comparison failures remain in the existing evaluation history.

Events contain a timestamp, an event name, and the internal user ID when authenticated. Session deduplication uses a hash; the log does not store emails, tokens, verification codes, queries, or notes. Events remain in the database until the owner deletes them. Local development does not record events. Logging failures produce a server warning and do not block sign-in or saving.
