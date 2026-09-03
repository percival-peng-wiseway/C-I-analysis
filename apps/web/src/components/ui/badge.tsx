import * as React from "react";

import { cn } from "@/lib/utils";

type BadgeVariant = "default" | "secondary" | "warning" | "success" | "outline";

const variants: Record<BadgeVariant, string> = {
  default: "bg-primary text-primary-foreground",
  secondary: "bg-muted text-muted-foreground",
  warning: "border-warning/35 bg-warning-subtle text-warning-foreground",
  success: "border-success/35 bg-success-subtle text-success-foreground",
  outline: "border-border bg-background text-foreground",
};

export function Badge({
  className,
  variant = "default",
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { variant?: BadgeVariant }) {
  return (
    <span
      className={cn(
        "inline-flex min-h-6 items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold leading-4",
        variants[variant],
        className,
      )}
      {...props}
    />
  );
}
