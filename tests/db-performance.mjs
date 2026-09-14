// Read-only comparison against the database named by DATABASE_URL in .env.local.
//
// The evaluations list is served by a projection rather than the whole document. This
// confirms the projection summarises identically to the full read, and reports how much
// it saves. It only reads, but it reads real evaluations.
import fs from "node:fs";
import assert from "node:assert/strict";
import { load } from "./load.mjs";

if (fs.existsSync(".env.local")) process.loadEnvFile(".env.local");

const cloud = load("lib/cloud-evaluations.ts", { env: process.env, globals: { fetch } });
const { evaluationSummary } = load("lib/evaluations.ts");

const full = await cloud.sql("SELECT data FROM evaluations ORDER BY created_at DESC LIMIT 100");
const projected = await cloud.sql(cloud.historyQuery);

assert.equal(full.length, projected.length, "the projection returns the same evaluations");
for (const [index, row] of full.entries()) {
  assert.equal(row.data.id, projected[index].data.id, `row ${index} is the same evaluation`);
  assert.deepEqual(
    evaluationSummary(row.data),
    evaluationSummary(projected[index].data),
    `row ${index} summarises identically`,
  );
}

const originalBytes = Buffer.byteLength(JSON.stringify(full));
const summaryBytes = Buffer.byteLength(JSON.stringify(projected));
console.log({
  evaluations: full.length,
  originalBytes,
  summaryBytes,
  reductionPercent: Math.round((1 - summaryBytes / originalBytes) * 100),
  summaryParity: "passed",
});
