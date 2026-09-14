"use client";
import { useCallback, useEffect, useState } from "react";

type Entry = { id: string; event: string; user_id: string | null; created_at: string };
const labels: Record<string, string> = {
  sign_in_started: "Sign-in started",
  sign_in_failed: "Sign-in failed",
  sign_in_succeeded: "Sign-in succeeded",
  workspace_opened: "Workspace opened",
  comparison_run: "Comparison run",
  grade_saved: "Feedback saved",
};
export default function ActivityPage() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/telemetry", { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error);
      setEntries(body);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not load app activity.");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return (
    <main className="mx-auto max-w-5xl space-y-4 px-6 py-8 pb-24">
      <h1 className="text-2xl font-semibold">App activity</h1>
      <p className="text-sm text-muted-foreground">
        Latest 200 events. Sign-in and workspace access appear once per session. Times use your
        local time zone. Sign-in attempts are anonymous.
      </p>
      <button
        type="button"
        className="rounded-md border px-3 py-2 text-sm"
        disabled={loading}
        onClick={refresh}
      >
        {loading ? "Loading…" : "Refresh activity"}
      </button>
      {error ? (
        <p role="alert">{error}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                <th className="p-2">Time</th>
                <th className="p-2">Event</th>
                <th className="p-2">User ID</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id} className="border-t">
                  <td className="p-2 whitespace-nowrap">
                    {new Date(entry.created_at).toLocaleString()}
                  </td>
                  <td className="p-2">{labels[entry.event] || entry.event}</td>
                  <td className="p-2 break-all">{entry.user_id || "Anonymous"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && entries.length === 0 && <p className="py-4">No activity recorded yet.</p>}
        </div>
      )}
    </main>
  );
}
