"use client";
import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function Group({
  title,
  detail,
  children,
}: {
  title: string;
  detail?: string;
  children: ReactNode;
}) {
  return (
    <details className="search-group">
      <summary>
        <span>
          <span className="block text-sm font-medium">{title}</span>
          {detail && <span className="mt-1 block text-xs text-muted-foreground">{detail}</span>}
        </span>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
      </summary>
      <div className="space-y-4 pb-5 pt-1">{children}</div>
    </details>
  );
}
export function NumberField({
  id,
  label,
  value,
  onChange,
  hint,
  error,
  min = 1,
  step = 1,
}: {
  id: string;
  label: string;
  value: number | null | undefined;
  onChange: (value: number | undefined) => void;
  hint?: string;
  error?: string;
  min?: number;
  step?: number | "any";
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${id}-error` : undefined}
        type="number"
        min={min}
        step={step}
        value={value ?? ""}
        placeholder="API default"
        onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
      />
      {error && (
        <p id={`${id}-error`} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
