import type { Config } from "tailwindcss";

// Keep the legacy cyan accent alias while using a pale-green / black workbench.
// Charts with fixed data-series colours use matching explicit legend colours.
const green = {
  50: "#f0f8ed", 100: "#e2f2db", 200: "#cbe6bd", 300: "#afd49c",
  400: "#82b96c", 500: "#588b44", 600: "#416f32", 700: "#325728",
  800: "#294623", 900: "#233b20", 950: "#142510",
};

const config = {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        slate: {
          50: "#f6f8f4", 100: "#eef1eb", 200: "#dfe4da", 300: "#cbd2c6",
          400: "#82877d", 500: "#676d62", 600: "#50564c", 700: "#3c4238",
          800: "#292e26", 900: "#191d17", 950: "#10130e",
        },
        cyan: green,
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        surface: {
          DEFAULT: "hsl(var(--surface))",
          subtle: "hsl(var(--surface-subtle))",
          raised: "hsl(var(--surface-raised))",
        },
        brand: {
          ...green,
          DEFAULT: "hsl(var(--brand))",
          foreground: "hsl(var(--brand-foreground))",
          subtle: "hsl(var(--brand-subtle))",
        },
        success: {
          DEFAULT: "hsl(var(--success))",
          foreground: "hsl(var(--success-foreground))",
          subtle: "hsl(var(--success-subtle))",
        },
        warning: {
          DEFAULT: "hsl(var(--warning))",
          foreground: "hsl(var(--warning-foreground))",
          subtle: "hsl(var(--warning-subtle))",
        },
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
      },
      borderRadius: {
        lg: "14px",
        md: "10px",
        sm: "7px",
      },
      boxShadow: {
        panel: "0 2px 8px rgb(47 42 31 / 0.025)",
      },
    },
  },
  plugins: [],
} satisfies Config;

export default config;
