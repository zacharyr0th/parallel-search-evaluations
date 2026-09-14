import { createHash, randomUUID } from "node:crypto";
import { sql } from "./cloud-evaluations";

export type ActivityEvent =
  | "sign_in_started"
  | "sign_in_failed"
  | "sign_in_succeeded"
  | "workspace_opened"
  | "comparison_run"
  | "grade_saved";

// Session identifiers are hashed before storage; the log never contains bearer credentials.
export async function recordActivity(event: ActivityEvent, userId?: string, sessionId?: string) {
  if (!process.env.VERCEL) return;
  const id = sessionId
    ? createHash("sha256").update(`${event}:${sessionId}`).digest("hex")
    : randomUUID();
  try {
    await sql(
      "INSERT INTO app_activity (id,event,user_id) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING",
      [id, event, userId || null],
    );
  } catch {
    // Logging must not turn a successful sign-in or saved grade into a failed request.
    console.warn("Activity log write failed.");
  }
}
