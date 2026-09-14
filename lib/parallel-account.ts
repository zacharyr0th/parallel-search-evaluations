import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { sql } from "./cloud-evaluations";

type Credentials = {
  access_token: string;
  refresh_token: string;
  client_id: string;
  expires_at: number;
};
function key() {
  const value = Buffer.from(process.env.PARALLEL_ACCOUNT_ENCRYPTION_KEY || "", "base64");
  if (value.length !== 32) throw new Error("Account encryption is not configured.");
  return value;
}
export function encryptCredentials(value: Credentials): string {
  const nonce = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key(), nonce);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), body]).toString("base64");
}
function decrypt(value: string): Credentials {
  const bytes = Buffer.from(value, "base64"),
    decipher = createDecipheriv("aes-256-gcm", key(), bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8"),
  );
}
export async function accountAccessToken(): Promise<string | null> {
  if (!process.env.PARALLEL_ACCOUNT_ENCRYPTION_KEY) return null;
  const rows = await sql("SELECT encrypted FROM parallel_account_credentials WHERE id='balance'");
  if (!rows.length) return null;
  let credentials = decrypt(String(rows[0].encrypted));
  if (credentials.expires_at > Date.now() + 60000) return credentials.access_token;
  const lease = randomUUID();
  const locked = await sql(
    "UPDATE parallel_account_credentials SET lease=$1, lease_until=NOW()+INTERVAL '60 seconds' WHERE id='balance' AND (lease_until IS NULL OR lease_until<NOW()) RETURNING encrypted",
    [lease],
  );
  if (!locked.length) throw new Error("Account authorization is refreshing.");
  try {
    credentials = decrypt(String(locked[0].encrypted));
    if (credentials.expires_at > Date.now() + 60000) return credentials.access_token;
    const response = await fetch("https://platform.parallel.ai/getServiceKeys/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: credentials.refresh_token,
        client_id: credentials.client_id,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error("Parallel account must be reconnected.");
    const fresh = await response.json();
    if (
      typeof fresh.access_token !== "string" ||
      !fresh.access_token ||
      typeof fresh.expires_in !== "number" ||
      fresh.expires_in <= 0 ||
      !Number.isFinite(fresh.expires_in) ||
      (fresh.refresh_token !== undefined &&
        (typeof fresh.refresh_token !== "string" || !fresh.refresh_token))
    )
      throw new Error("Invalid account authorization.");
    const next = {
      ...credentials,
      access_token: fresh.access_token,
      refresh_token: fresh.refresh_token || credentials.refresh_token,
      expires_at: Date.now() + fresh.expires_in * 1000,
    };
    const saved = await sql(
      "UPDATE parallel_account_credentials SET encrypted=$1 WHERE id='balance' AND lease=$2 RETURNING id",
      [encryptCredentials(next), lease],
    );
    if (!saved.length) throw new Error("Account authorization could not be saved.");
    return next.access_token;
  } finally {
    await sql(
      "UPDATE parallel_account_credentials SET lease=NULL,lease_until=NULL WHERE id='balance' AND lease=$1",
      [lease],
    );
  }
}
