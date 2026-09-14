import { type NextRequest, NextResponse } from "next/server";
import { recordActivity } from "./lib/telemetry";
import { auth, accessContext, localDevelopment } from "./lib/auth";

export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  if (path === "/sign-in" && request.nextUrl.searchParams.has("neon_auth_session_verifier")) {
    try {
      const sessionResponse = await auth
        .handler()
        .GET(request, { params: Promise.resolve({ path: ["get-session"] }) });
      const session = sessionResponse.ok ? await sessionResponse.json() : null;
      if (session?.session && session?.user) {
        const response = NextResponse.redirect(new URL("/", request.url));
        for (const cookie of sessionResponse.headers.getSetCookie())
          response.headers.append("Set-Cookie", cookie);
        response.headers.set("Cache-Control", "no-store");
        return response;
      }
    } catch {
      /* Show the email fallback when the exchange is unavailable. */
    }
    await recordActivity("sign_in_failed");
    const response = NextResponse.redirect(new URL("/sign-in?google_error=1", request.url));
    response.headers.set("Cache-Control", "no-store");
    return response;
  }
  // Local development grants access without a session but still serves /sign-in, so the page can
  // be previewed and signing out lands somewhere.
  if (localDevelopment(request)) return NextResponse.next();
  if (path === "/sign-in" || path.startsWith("/api/auth/")) return NextResponse.next();
  // API handlers independently enforce the same verified-email policy.
  if (path.startsWith("/api/")) return NextResponse.next();
  const response = await auth.middleware({ loginUrl: "/sign-in" })(request);
  if (response.headers.has("location")) return response;
  const { status, userId, sessionId } = await accessContext(request);
  if (status === 200) {
    if ((path === "/" || path === "/runs") && !request.headers.has("next-router-prefetch") && request.headers.get("purpose") !== "prefetch")
      await recordActivity("workspace_opened", userId, sessionId);
    return response;
  }
  if (status === 503)
    return new NextResponse("Sign-in service unavailable. Please retry.", { status: 503 });
  if (status === 403) await recordActivity("sign_in_failed");
  return NextResponse.redirect(
    new URL(status === 403 ? "/sign-in?denied=1" : "/sign-in", request.url),
  );
}
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|parallel-logo.svg).*)"],
};
