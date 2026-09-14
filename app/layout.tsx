import type { Metadata } from "next";
import "./globals.css";
import { ScrollIndicators, APICredits } from "@/components/layout-chrome";
export const metadata: Metadata = {
  title: "Evaluate · Parallel Search evaluations",
  description: "Review Parallel search results and save human feedback.",
  icons: { icon: "/parallel-logo.svg" },
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: a static, blocking theme script that must run before first paint to avoid a flash.
          dangerouslySetInnerHTML={{
            __html: `(function () {
  var media = window.matchMedia('(prefers-color-scheme: dark)');
  var preference = 'system';
  function read() {
    try { preference = localStorage.getItem('color-theme') || 'system'; } catch {}
    if (!['light', 'dark', 'system'].includes(preference)) preference = 'system';
  }
  function apply() {
    document.documentElement.classList.toggle('dark', preference === 'dark' || (preference === 'system' && media.matches));
    document.documentElement.dataset.themePreference = preference;
    window.dispatchEvent(new Event('theme-change'));
  }
  read(); apply();
  media.addEventListener('change', apply);
  window.addEventListener('storage', function (event) {
    if (event.key === 'color-theme' || event.key === null) { read(); apply(); }
  });
  window.addEventListener('theme-preference', function (event) {
    if (!['light', 'dark', 'system'].includes(event.detail)) return;
    preference = event.detail;
    try { localStorage.setItem('color-theme', preference); } catch {}
    apply();
  });
})()`,
          }}
        />
      </head>
      <body>
        {children}
        <ScrollIndicators />
        <APICredits />
      </body>
    </html>
  );
}
