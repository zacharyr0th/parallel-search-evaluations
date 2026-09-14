import { NextRequest } from "next/server";
import { createNeonAuth } from "@neondatabase/auth/next/server";
import { recordActivity } from "./telemetry";
import { allowedUser } from "./allowed-user";

export const auth = createNeonAuth({
  baseUrl: process.env.NEON_AUTH_BASE_URL!,
  cookies: { secret: process.env.NEON_AUTH_COOKIE_SECRET!, sessionDataTtl: 60 },
});

export function localDevelopment(request: NextRequest): boolean {
  const port = process.env.PORT || "3000";
  return (
    process.env.NODE_ENV === "development" &&
    !process.env.VERCEL &&
    ["127.0.0.1", "localhost"].includes(request.nextUrl.hostname) &&
    [`127.0.0.1:${port}`, `localhost:${port}`].includes(request.headers.get("host") || "")
  );
}

// Ratings are attributed to whoever saved them, so the local bypass has to name itself.
// DEV_REVIEWER lets a local session say who is grading rather than filing everything under one
// anonymous label; it applies only where localDevelopment already grants access.
export async function accessContext(
  request: NextRequest,
): Promise<{ status: 200 | 401 | 403 | 503; actor?: string; userId?: string; sessionId?: string }> {
  if (localDevelopment(request))
    return { status: 200, actor: process.env.DEV_REVIEWER || "Local development" };
  try {
    const response = await auth.handler().GET(
      new NextRequest(request.url, {
        headers: request.headers,
      }),
      { params: Promise.resolve({ path: ["get-session"] }) },
    );
    if (!response.ok) return { status: 503 };
    const session = await response.json();
    if (!session?.session || !session?.user) return { status: 401 };
    if (!allowedUser(session.user)) return { status: 403 };
    await recordActivity("sign_in_succeeded", session.user.id, session.session.id);
    return { status: 200, actor: session.user.email, userId: session.user.id, sessionId: session.session.id };
  } catch {
    return { status: 503 };
  }
}
