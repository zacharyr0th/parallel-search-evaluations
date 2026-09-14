"use client";

import { useId, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuGroup,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { ChevronDown, Copy, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ExportFormat, CopyFormat } from "@/lib/share-evaluations";

const exportFormats = [
  ["json", "JSON", "Complete evaluation"],
  ["csv", "CSV", "Spreadsheet rows"],
  ["jsonl", "JSONL", "Result records"],
] as const;

// One source for the format names, so the confirmation text cannot drift from the menu.
const copyNames = { text: "Plain text", markdown: "Markdown", json: "JSON", link: "Link" } as const;
const copyOrder = ["text", "markdown", "json"] as const;

export function ExportMenu({
  disabled,
  onExport,
}: {
  disabled?: boolean;
  onExport: (format: ExportFormat) => void | Promise<void>;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        aria-label="Export evaluation"
        render={<Button variant="outline" size="sm" />}
      >
        <Download />
        Export
        <ChevronDown />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" aria-label="Export format" className="min-w-56">
        {exportFormats.map(([format, label, description]) => (
          <DropdownMenuItem
            key={format}
            onClick={() => {
              void onExport(format);
            }}
            className="flex-col items-start gap-0.5"
          >
            <span className="text-sm font-medium">{label}</span>
            <span className="text-xs text-muted-foreground">{description}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function CopyMenu({
  label,
  compact = false,
  disabled,
  blockedReason,
  link,
  filteredLabel,
  getText,
}: {
  label: string;
  compact?: boolean;
  disabled?: boolean;
  blockedReason?: string;
  link?: string;
  filteredLabel?: string;
  getText: (format: CopyFormat, filtered?: boolean) => string;
}) {
  const helpId = useId();
  const [status, setStatus] = useState("");
  const [failed, setFailed] = useState(false);
  async function copy(format: CopyFormat | "link", filtered = false) {
    setStatus("");
    setFailed(false);
    try {
      await navigator.clipboard.writeText(format === "link" ? link! : getText(format, filtered));
      setStatus(`${copyNames[format]} copied${filtered ? " · Filtered results" : ""}`);
    } catch (error) {
      setFailed(true);
      setStatus(
        error instanceof Error && error.message.startsWith("Save notes")
          ? error.message
          : "Copy failed. Try again or use Export.",
      );
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={disabled || Boolean(blockedReason)}
          aria-describedby={blockedReason ? helpId : undefined}
          render={
            <Button
              type="button"
              variant={compact ? "ghost" : "outline"}
              size={compact ? "icon-sm" : "sm"}
            />
          }
          aria-label={label}
          title={label}
        >
          <Copy />
          {!compact && (
            <>
              {label}
              <ChevronDown />
            </>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" aria-label={`${label} format`} className="min-w-56">
          {link && (
            <DropdownMenuItem
              onClick={() => {
                void copy("link");
              }}
            >
              Copy link
            </DropdownMenuItem>
          )}
          {[false, ...(filteredLabel ? [true] : [])].map((filtered) => (
            <DropdownMenuGroup key={String(filtered)}>
              {filteredLabel && (
                <DropdownMenuLabel>{filtered ? filteredLabel : "All results"}</DropdownMenuLabel>
              )}
              {copyOrder.map((format) => (
                <DropdownMenuItem
                  key={format}
                  onClick={() => {
                    void copy(format, filtered);
                  }}
                >
                  {filtered ? `${copyNames[format]} · Filtered results` : copyNames[format]}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {blockedReason && (
        <span id={helpId} className="max-w-56 text-xs text-muted-foreground">
          {blockedReason}
        </span>
      )}
      {!blockedReason && status && (
        <span
          role={failed ? "alert" : "status"}
          className={`max-w-56 text-xs ${failed ? "text-destructive" : "text-muted-foreground"}`}
        >
          {status}
        </span>
      )}
    </div>
  );
}
