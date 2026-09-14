"use client";
import { clearAPIReads } from "@/lib/evaluations";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, useSyncExternalStore } from "react";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverTitle,
  PopoverDescription,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";
import { Moon, Sun } from "lucide-react";

function subscribe(notify: () => void) {
  window.addEventListener("theme-change", notify);
  return () => window.removeEventListener("theme-change", notify);
}
const snapshot = () => document.documentElement.classList.contains("dark");
const serverSnapshot = () => false;

export function ThemeToggle() {
  const dark = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  const next = dark ? "light" : "dark";
  const Icon = dark ? Sun : Moon;
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
      onClick={() => {
        window.dispatchEvent(new CustomEvent("theme-preference", { detail: next }));
      }}
    >
      <Icon aria-hidden="true" className="size-4" />
    </Button>
  );
}

const navLinks = [
  ["/", "Evaluate"],
  ["/runs", "Evaluations"],
] as const;

export function WorkspaceNav() {
  const pathname = usePathname();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function signOut() {
    setBusy(true);
    setError("");
    try {
      clearAPIReads();
      const result = await authClient.signOut();
      if (result.error) throw new Error();
      router.replace("/sign-in");
      router.refresh();
    } catch {
      setError("Sign-out failed. Select Sign out to try again.");
      setBusy(false);
    }
  }
  const { data: session } = authClient.useSession();
  const user = session?.user;
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const initials = (user?.name || user?.email || "?")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
  return (
    <nav aria-label="Workspace" className="flex items-center gap-3 text-xs">
      <div className="flex items-center gap-1 rounded-lg bg-muted p-1">
        {navLinks.map(([href, label]) => {
          const current = pathname === href;
          return (
            <Link
              key={href}
              href={href}
              onNavigate={(event) => {
                // Staying put, or a page that vetoes the move (unsaved work), cancels the navigation.
                if (
                  current ||
                  !window.dispatchEvent(new Event("evaluation:navigate", { cancelable: true }))
                )
                  event.preventDefault();
              }}
              aria-current={current ? "page" : undefined}
              className={`rounded-md px-3 py-2 font-medium focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 ${current ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
            >
              {label}
            </Link>
          );
        })}
      </div>
      <ThemeToggle />
      <Popover>
        <PopoverTrigger
          aria-label={user?.email ? `Account: ${user.email}` : "Account"}
          title={user?.email || "Account"}
          className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-full border bg-card text-muted-foreground transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 data-popup-open:ring-2 data-popup-open:ring-ring"
        >
          {user?.image && failedImage !== user.image ? (
            // Provider avatars retain their original URL and do not need image optimization.
            // biome-ignore lint/performance/noImgElement: a provider avatar keeps its original URL and does not need next/image optimization.
            <img
              src={user.image}
              alt=""
              referrerPolicy="no-referrer"
              className="size-full object-cover"
              onError={() => setFailedImage(user.image!)}
            />
          ) : (
            <span aria-hidden="true" className="font-semibold">
              {initials}
            </span>
          )}
        </PopoverTrigger>
        <PopoverContent align="end" className="max-w-[calc(100vw-2rem)] p-4">
          <PopoverTitle className="text-sm font-semibold">{user?.name || "Account"}</PopoverTitle>
          <PopoverDescription className="mt-1 break-all text-sm text-muted-foreground">
            {user?.email || "Loading account…"}
          </PopoverDescription>
          <div className="mt-4 border-t pt-3">
            {user?.emailVerified && user.email.toLowerCase() === "eas.vone@gmail.com" && (
              <Link href="/activity" className="mb-3 block text-sm underline">App activity</Link>
            )}
            <Button variant="outline" className="w-full" disabled={busy || !user} onClick={signOut}>
              {busy ? "Signing out…" : "Sign out"}
            </Button>
            {error && (
              <p role="alert" className="mt-2 text-sm text-destructive">
                {error}
              </p>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </nav>
  );
}
