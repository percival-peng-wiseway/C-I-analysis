import * as React from "react";

import { cn } from "@/lib/utils";

type ButtonVariant = "default" | "secondary" | "outline" | "ghost";
type ButtonSize = "default" | "sm" | "lg" | "icon";

const variants: Record<ButtonVariant, string> = {
  default: "border border-primary bg-primary text-primary-foreground shadow-sm hover:bg-primary/90",
  secondary: "border border-transparent bg-muted text-foreground hover:bg-muted/75",
  outline: "border border-border bg-background text-foreground shadow-sm hover:border-slate-300 hover:bg-surface-subtle",
  ghost: "border border-transparent text-foreground hover:bg-muted",
};

const sizes: Record<ButtonSize, string> = {
  default: "h-10 px-4",
  sm: "h-9 px-3 text-xs",
  lg: "h-11 px-5",
  icon: "size-10 p-0",
};

export const Button = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { size?: ButtonSize; variant?: ButtonVariant }
>(function Button({ className, size = "default", variant = "default", ...props }, ref) {
  return (
    <button
      className={cn(
        "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-semibold transition-[background-color,border-color,color,box-shadow,transform] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50 disabled:active:translate-y-0",
        variants[variant],
        sizes[size],
        className,
      )}
      ref={ref}
      {...props}
    />
  );
});
