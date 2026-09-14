-- The whole database schema. Apply this file against a new database; the app does not
-- create tables at startup. Every statement is idempotent, so re-applying it is safe and
-- also brings an existing database up to date.

CREATE TABLE IF NOT EXISTS evaluations (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- History pages order by (created_at DESC, id DESC); carrying id in the index means the
-- tie-break needs no sort.
CREATE INDEX IF NOT EXISTS evaluations_recent_id
  ON evaluations (created_at DESC, id DESC);

-- The feedback fallback locates an evaluation by a contained result id. Without this the
-- lookup scans and re-parses every evaluation document.
CREATE INDEX IF NOT EXISTS evaluations_data_contains
  ON evaluations USING gin (data jsonb_path_ops);

-- One row per UTC day. The search handler increments `calls` and refuses the request when
-- the increment would exceed the shared workspace's daily Search API allowance.
CREATE TABLE IF NOT EXISTS search_budget (
  day date PRIMARY KEY,
  calls integer NOT NULL
);

CREATE TABLE IF NOT EXISTS evaluation_activity (
  id uuid PRIMARY KEY,
  evaluation_id text NOT NULL REFERENCES evaluations(id),
  actor text NOT NULL,
  action text NOT NULL CHECK (action IN ('opened', 'clicked', 'created', 'feedback saved')),
  target text NOT NULL CHECK (length(target) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS evaluation_activity_timeline
  ON evaluation_activity (evaluation_id, created_at DESC, id DESC);

-- The grading audit trail. A rating used to append to data->'feedback_history' inside the
-- same evaluation row that the rating rewrites in full, so cost per rating grew with the
-- number of ratings already recorded. Ratings append here instead, and reads union this
-- table with the legacy in-document arrays so older evaluations keep their history.
CREATE TABLE IF NOT EXISTS evaluation_feedback (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  evaluation_id text NOT NULL REFERENCES evaluations(id) ON DELETE CASCADE,
  result_id bigint NOT NULL,
  actor text NOT NULL,
  relevance smallint CHECK (relevance BETWEEN 0 AND 3),
  issues jsonb NOT NULL DEFAULT '[]'::jsonb,
  rubric_version text,
  notes text NOT NULL DEFAULT '',
  version integer NOT NULL CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- One row per saved revision: a retried save cannot double-record the same edit.
  UNIQUE (evaluation_id, result_id, version)
);

CREATE INDEX IF NOT EXISTS evaluation_feedback_timeline
  ON evaluation_feedback (evaluation_id, created_at DESC, id DESC);

-- Cross-evaluation grading statistics (per reviewer, per rubric) read this directly
-- instead of unpacking every evaluation document.
CREATE INDEX IF NOT EXISTS evaluation_feedback_actor
  ON evaluation_feedback (actor, created_at DESC);

-- Encrypted Parallel account credentials, one row.
CREATE TABLE IF NOT EXISTS parallel_account_credentials (
  id text PRIMARY KEY CHECK (id = 'balance'),
  encrypted text NOT NULL,
  lease text,
  lease_until timestamptz
);
REVOKE ALL ON parallel_account_credentials FROM PUBLIC;

-- Bring a database built before this file up to date: the activity check once allowed only
-- 'opened' and 'clicked', and the evaluations list once had its own index that
-- evaluations_recent_id now covers.
ALTER TABLE evaluation_activity DROP CONSTRAINT IF EXISTS evaluation_activity_action_check;
ALTER TABLE evaluation_activity ADD CONSTRAINT evaluation_activity_action_check
  CHECK (action IN ('opened', 'clicked', 'created', 'feedback saved'));
DROP INDEX IF EXISTS evaluations_recent;

-- This table was created with a binary correct/incorrect column beside the grade. It is
-- retired: a relevance grade of 2 or 3 means the result met the need, so the binary is
-- derived on read instead of stored twice and left to disagree. No version of the app ever
-- wrote it, so dropping it loses no judgment and removes a column a reader would otherwise
-- expect to find populated.
ALTER TABLE evaluation_feedback DROP COLUMN IF EXISTS judgment;

-- Owner-only operational events. No submitted content or authentication credentials.
CREATE TABLE IF NOT EXISTS app_activity (
  id text PRIMARY KEY,
  event text NOT NULL CHECK (event IN ('sign_in_started','sign_in_failed','sign_in_succeeded','workspace_opened','comparison_run','grade_saved')),
  user_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS app_activity_recent ON app_activity (created_at DESC, id DESC);
