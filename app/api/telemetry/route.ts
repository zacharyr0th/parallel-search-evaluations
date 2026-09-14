import { type NextRequest, NextResponse } from "next/server";
import { accessContext } from "../../../lib/auth";
import { sql } from "../../../lib/cloud-evaluations";

export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  const access = await accessContext(request);
  const headers = { "Cache-Control": "no-store" };
  if (access.status !== 200 || access.actor?.toLowerCase() !== "eas.vone@gmail.com")
    return NextResponse.json(
      { error: "Only the owner can view app activity." },
      { status: access.status === 200 ? 403 : access.status, headers },
    );
  try {
    const rows = await sql(
      "SELECT id,event,user_id,created_at FROM app_activity ORDER BY created_at DESC,id DESC LIMIT 200",
    );
    return NextResponse.json(rows, { headers });
  } catch {
    return NextResponse.json(
      { error: "Could not load app activity. Try again." },
      { status: 503, headers },
    );
  }
}
