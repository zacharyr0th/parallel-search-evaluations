"use client";
import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { ProfileLinks } from "@/components/profile-links";

export function ScrollIndicators() {
  useEffect(() => {
    const timers = new Map<Element, ReturnType<typeof setTimeout>>();
    const onScroll = (event: Event) => {
      const element = event.target === document ? document.documentElement : event.target;
      if (!(element instanceof Element)) return;
      const running = timers.get(element);
      if (running) clearTimeout(running);
      else element.setAttribute("data-scrolling", "");
      timers.set(
        element,
        setTimeout(() => {
          element.removeAttribute("data-scrolling");
          timers.delete(element);
        }, 800),
      );
    };
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => {
      document.removeEventListener("scroll", onScroll, true);
      timers.forEach((timer, element) => {
        clearTimeout(timer);
        element.removeAttribute("data-scrolling");
      });
    };
  }, []);
  return null;
}

type Balance = {
  available: boolean;
  invoiced?: boolean;
  balanceCents?: number;
  currency?: string;
  reason?: string;
  reason_code?: string;
};
export function APICredits() {
  const pathname = usePathname();
  const [balance, setBalance] = useState<Balance | null>(null);
  const lastFetch = useRef(0);
  const hidden = pathname === "/sign-in";
  // Keep an in-flight balance request alive when navigating between workspace pages.
  useEffect(() => {
    if (hidden) {
      setBalance(null);
      lastFetch.current = 0;
      return;
    }
    let active = true;
    const controller = new AbortController();
    let pending = false;
    async function refresh() {
      if (pending || Date.now() - lastFetch.current < 15000) return;
      pending = true;
      try {
        const response = await fetch("/api/credits", {
          cache: "no-store",
          signal: controller.signal,
        });
        const body = await response.json().catch(() => null);
        const data: Balance = response.ok
          ? body
          : { available: false, reason: body?.error || "Sign in to view API credits." };
        if (active) setBalance(data);
      } catch {
        if (active)
          setBalance({ available: false, reason: "Could not retrieve the credit balance." });
      } finally {
        if (active) lastFetch.current = Date.now();
        pending = false;
      }
    }
    void refresh();
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 60000);
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [hidden]);
  // The sign-in page carries its own footer, and credits need a session.
  if (hidden) return null;
  const label = !balance
    ? "Checking credits…"
    : !balance.available
      ? "Credits unavailable"
      : balance.invoiced
        ? "API billing: invoiced"
        : `${new Intl.NumberFormat("en-US", { style: "currency", currency: balance.currency || "USD" }).format(balance.balanceCents! / 100)} API credits`;
  return (
    <footer className="pointer-events-none fixed inset-x-0 bottom-0 z-40 h-[60px] mx-auto flex w-full max-w-[1600px] items-center justify-between gap-3 px-6 max-[800px]:px-4 lg:px-8">
      <div className="pointer-events-auto flex min-w-0 flex-wrap items-center gap-x-2 rounded-md bg-card/40 px-2 py-1 text-xs text-muted-foreground backdrop-blur-sm">
        <span className="basis-full whitespace-nowrap sm:basis-auto">Zachary Roth’s Submission</span>
        <nav aria-label="Zachary Roth’s profiles" className="flex items-center gap-1">
          <ProfileLinks />
        </nav>
      </div>
      <span
        title={balance?.reason || "Parallel prepaid balance. Refreshes every minute."}
        className="pointer-events-auto shrink-0 rounded-full border bg-card px-3 py-1 text-xs tabular-nums text-muted-foreground shadow-sm"
      >
        {label}
      </span>
    </footer>
  );
}
