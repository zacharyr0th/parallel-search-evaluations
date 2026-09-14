"use client";
import { clearAPIReads } from "@/lib/evaluations";
import Link from "next/link";
import { ProfileLinks } from "@/components/profile-links";
import { ThemeToggle } from "@/components/workspace-nav";
import { Mail } from "lucide-react";
import Image from "next/image";
import googleIcon from "@/public/google-g.png";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { allowedEmail, allowedUser } from "@/lib/allowed-user";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";


export default function SignIn() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { data: session, isPending } = authClient.useSession();
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      if (!allowedEmail(email)) throw new Error("Use your @parallel.ai email or an approved account.");
      const result = sent
        ? await authClient.signIn.emailOtp({ email, otp })
        : await authClient.emailOtp.sendVerificationOtp({ email, type: "sign-in" });
      if (result.error) throw new Error(result.error.message || "Sign-in failed. Try again.");
      if (sent) {
        router.replace("/");
        router.refresh();
      } else setSent(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sign-in failed. Try again.");
    } finally {
      setBusy(false);
    }
  }
  async function google() {
    setError("");
    setBusy(true);
    try {
      const result = await authClient.signIn.social({
        provider: "google",
        callbackURL: new URL("/", window.location.href).href,
        errorCallbackURL: new URL("/sign-in?google_error=1", window.location.href).href,
      });
      if (result.error) throw new Error(result.error.message || "Sign-in failed. Try again.");
    } catch {
      setError("Google sign-in failed. Use an email code instead.");
      setBusy(false);
      document.getElementById("email")?.focus();
    }
  }
  async function signOut() {
    setError("");
    setBusy(true);
    try {
      clearAPIReads();
      const result = await authClient.signOut();
      if (result.error) throw new Error();
      router.replace("/sign-in");
      router.refresh();
    } catch {
      setError("Sign-out failed. Select Sign out to try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="sign-in-page flex min-h-dvh flex-col items-center gap-6 p-4 sm:p-6">
      <div className="absolute right-4 top-4 sm:right-6 sm:top-6">
        <ThemeToggle />
      </div>
      <section
        className="my-auto w-full max-w-sm space-y-6 rounded-xl border bg-card p-6 shadow-lg sm:p-8"
        aria-labelledby="sign-in-title"
      >
        <div className="flex items-center gap-2.5">
          {/* biome-ignore lint/performance/noImgElement: a static local SVG needs no next/image optimization. */}
          <img src="/parallel-logo.svg" alt="Parallel" className="size-7" />
          <span className="brand-wordmark" aria-hidden="true">
            parallel
          </span>
        </div>
        {session?.user ? (
          <div className="space-y-1.5">
            <h1 id="sign-in-title" className="text-lg font-semibold">
              Account
            </h1>
            <p className="text-sm text-muted-foreground">Parallel Search evaluations</p>
          </div>
        ) : (
          <div>
            {/* The heading stays for screen readers; the brand row names the page visually. */}
            <h1 id="sign-in-title" className="sr-only">
              Sign in
            </h1>
            <p className="text-sm text-muted-foreground">Use your @parallel.ai email or an approved account.</p>
          </div>
        )}
        {isPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            Loading account…
          </p>
        ) : session?.user ? (
          <div className="space-y-6">
            <dl className="space-y-4 text-sm">
              <div>
                <dt className="text-muted-foreground">Name</dt>
                <dd className="mt-1 font-medium">{session.user.name || "Not provided"}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Email</dt>
                <dd className="mt-1 flex items-center gap-2">
                  <Mail aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                  <span className="break-all">{session.user.email}</span>
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Access</dt>
                <dd className="mt-1">
                  {allowedUser(session.user)
                    ? "Approved · Email verified"
                    : "This account does not have access."}
                </dd>
              </div>
            </dl>
            <div className="flex items-center justify-between gap-4 border-t pt-4">
              {allowedUser(session.user) && (
                <Link href="/runs" className="text-sm underline underline-offset-4">
                  Saved evaluations
                </Link>
              )}
              <Button variant="outline" disabled={busy} onClick={signOut}>
                {busy ? "Signing out…" : "Sign out"}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-5">
            <Button
              className="h-9 w-full gap-2.5"
              variant="outline"
              disabled={busy || isPending}
              onClick={google}
            >
              <Image src={googleIcon} alt="" aria-hidden="true" width={20} height={20} />
              Continue with Google
            </Button>
            {/* Google and an email code are equal ways in, not a primary and a fallback: a Parallel
            address is not necessarily a Google account, so the code form stays visible. */}
            <div className="flex items-center gap-3">
              <span aria-hidden="true" className="h-px flex-1 bg-border" />
              <span className="text-xs text-muted-foreground">or</span>
              <span aria-hidden="true" className="h-px flex-1 bg-border" />
            </div>
            <form className="space-y-4" onSubmit={submit}>
              <div className="space-y-2">
                <label htmlFor="email" className="text-sm font-medium">
                  Email
                </label>
                <Input
                  className="h-9"
                  id="email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  disabled={busy || sent}
                  onChange={(e) => setEmail(e.target.value.trim().toLowerCase())}
                />
              </div>
              {sent && (
                <div className="space-y-2">
                  <label htmlFor="code" className="text-sm font-medium">
                    Verification code
                  </label>
                  <Input
                    className="h-9"
                    id="code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    required
                    value={otp}
                    onChange={(e) => setOtp(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Enter the code sent to your email.
                  </p>
                </div>
              )}
              <Button type="submit" className="h-9 w-full" disabled={busy}>
                {busy ? (sent ? "Verifying code…" : "Sending code…") : sent ? "Verify and sign in" : "Send sign-in code"}
              </Button>
              {sent && (
                <Button
                  className="w-full"
                  variant="ghost"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setSent(false);
                    setOtp("");
                  }}
                >
                  Change email
                </Button>
              )}
            </form>
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </section>
      <footer className="flex items-center gap-2 rounded-full border bg-card py-1 pr-1 pl-4 text-xs text-muted-foreground shadow-sm">
        <span>Zachary Roth’s Submission</span>
        <span aria-hidden="true" className="h-4 w-px bg-border" />
        <ProfileLinks />
      </footer>
    </main>
  );
}
