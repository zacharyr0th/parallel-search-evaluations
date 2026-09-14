# Database schema and development checks

This file covers the database schema and every check in [`tests/`](tests/), including what
each check needs to run. See setup, the review workflow, and the grading rubric in the
[repository README](README.md).

## Schema

Apply [`schema.sql`](schema.sql) against a new database. Every statement is idempotent, so
you can run it again to apply the schema changes defined in that file.

| Table | What it holds |
| --- | --- |
| `evaluations` | One row per saved evaluation, with its results as a JSON document |
| `search_budget` | One row per UTC day, counting calls against the daily Search API allowance |
| `evaluation_activity` | The activity timeline |
| `evaluation_feedback` | The grading audit trail, with its lookup indexes |
| `parallel_account_credentials` | Encrypted credentials |

A rating writes one row to `evaluation_feedback` and rewrites only its own result inside the
evaluation document, guarded by that result's version. Reviewers grading different results
do not cause result-version conflicts. If two reviewers save the same result version, the second save returns `409 stale_result_version`.

Evaluations saved before `evaluation_feedback` existed keep their history inside the document.
Reads merge both sources, so no evaluation loses history.

## Checks

Library and browser tests use fixtures for Search API responses and do not spend API credits.
Database checks use PostgreSQL; see their database requirements below.
The live check, `tests/cloud.py`, uses API credits and saves an evaluation. See
[deployment verification](DEPLOYMENT.md) for its requirements.

### Library, lint, and build checks

Install dependencies with `npm ci` before running these checks.

```sh
npm test
npm run lint
npm run build
```

`npm run lint` runs Biome against [`biome.jsonc`](biome.jsonc), which extends the shared
[Trellis](https://github.com/raintree-technology/trellis) policy and then records this
project's own exceptions, each with the reason it is an exception. It fails on errors only;
the warnings it prints are advisory. `npm run lint:todo` writes the same findings to
`trellis-todo.json` as structured JSON.

`npm test` runs [`tests/backend.mjs`](tests/backend.mjs), which covers the library modules,
and [`tests/routes.mjs`](tests/routes.mjs), which covers the API routes, the page proxy, and
the local-access rule. To narrow a run, pass a test-name pattern:

```sh
node --test-name-pattern=export tests/backend.mjs
```

### Checks that need a development server

Start `npm run dev` at [the local app address](http://127.0.0.1:3000), then run:

```sh
npm run test:browser
```

This runs [`tests/workspace.mjs`](tests/workspace.mjs), which covers the workspace shell,
the review loop end to end, grading with the activity log, and responsive layout. Set
`UI_TEST_URL` to run against another origin; the layout cases ignore it and always request
[the local app address](http://127.0.0.1:3000).

### Checks that need a production build

Run `npm run build` first, then:

```sh
npm run test:built
```

[`tests/built.mjs`](tests/built.mjs) covers the copy and export menus, the search sidebar,
and sign-in. The first two serve the bundle from `.next`, so no server has to be
running. Sign-in starts its own server on port 3011 and stops it afterwards; set
`AUTH_TEST_URL` to check a deployed instance instead. It initiates Google sign-in without
completing it and answers every email code from a fixture, so it sends no verification
email.

### Checks that need a PostgreSQL database

The grading write path is one SQL statement, so its correctness is checked against a real
PostgreSQL database. Point `TEST_DATABASE_URL` at a scratch database,
never one holding real evaluations, because each run clears the application tables in that database:

```sh
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:54329/scratch npm run test:database
```

Any empty PostgreSQL database works, because [`tests/grading.mjs`](tests/grading.mjs)
applies the schema itself. Without `TEST_DATABASE_URL`, the check reports that it was skipped. To start a throwaway cluster with the Homebrew build:

1. Name the binaries: `PG=$(brew --prefix postgresql@18)/bin`
2. Create the cluster: `$PG/initdb -D /tmp/evaltest -U postgres --auth=trust`
3. Start it: `$PG/pg_ctl -D /tmp/evaltest -o "-p 54329 -h 127.0.0.1 -c unix_socket_directories=" -l /tmp/evaltest/server.log start`
4. Create the database: `$PG/psql -h 127.0.0.1 -p 54329 -U postgres -c "create database scratch"`

Step 3 disables the socket directory because its long path exceeds the 103-byte limit. Stop
the cluster with `$PG/pg_ctl -D /tmp/evaltest stop`.

### Check that reads real evaluations

```sh
node tests/db-performance.mjs
```

[`tests/db-performance.mjs`](tests/db-performance.mjs) reads the database named by
`DATABASE_URL` in `.env.local` and confirms that the history query returns the same
summaries as the full documents, reporting how many bytes it saves. This check reads existing evaluations without changing them.
