/** @type {import('tailwindcss').Config} */
export default {
  // Light mode only — no `dark` strategy, no dark: variants anywhere.
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
        mono: [
          "JetBrains Mono",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Consolas",
          "monospace",
        ],
      },
      colors: {
        // Exact hex via RGB channels; `<alpha-value>` keeps opacity modifiers working.
        border: {
          DEFAULT: "rgb(var(--border) / <alpha-value>)",
          subtle: "rgb(var(--border-subtle) / <alpha-value>)", // #ededed — row separators
          strong: "rgb(var(--border-strong) / <alpha-value>)", // #c7c7c7 — emphasis
        },
        input: "rgb(var(--input) / <alpha-value>)",
        ring: "rgb(var(--ring) / <alpha-value>)",
        background: "rgb(var(--background) / <alpha-value>)",
        foreground: "rgb(var(--foreground) / <alpha-value>)",
        // Text ladder (secondary lives on muted.foreground)
        tertiary: "rgb(var(--text-tertiary) / <alpha-value>)",
        placeholder: "rgb(var(--text-placeholder) / <alpha-value>)",
        primary: {
          DEFAULT: "rgb(var(--primary) / <alpha-value>)",
          foreground: "rgb(var(--primary-foreground) / <alpha-value>)", // near-black on green
          hover: "rgb(var(--primary-hover) / <alpha-value>)",
          subtle: "rgb(var(--primary-subtle) / <alpha-value>)",
        },
        secondary: {
          DEFAULT: "rgb(var(--secondary) / <alpha-value>)",
          foreground: "rgb(var(--secondary-foreground) / <alpha-value>)",
        },
        muted: {
          DEFAULT: "rgb(var(--muted) / <alpha-value>)",
          foreground: "rgb(var(--muted-foreground) / <alpha-value>)",
        },
        accent: {
          DEFAULT: "rgb(var(--accent) / <alpha-value>)",
          foreground: "rgb(var(--accent-foreground) / <alpha-value>)",
        },
        success: {
          DEFAULT: "rgb(var(--success) / <alpha-value>)",
          foreground: "rgb(var(--success-foreground) / <alpha-value>)",
          subtle: "rgb(var(--success-subtle) / <alpha-value>)",
          border: "rgb(var(--success-border) / <alpha-value>)",
        },
        warn: {
          DEFAULT: "rgb(var(--warn) / <alpha-value>)",
          foreground: "rgb(var(--warn-foreground) / <alpha-value>)",
          subtle: "rgb(var(--warn-subtle) / <alpha-value>)",
          border: "rgb(var(--warn-border) / <alpha-value>)",
        },
        destructive: {
          DEFAULT: "rgb(var(--destructive) / <alpha-value>)",
          foreground: "rgb(var(--destructive-foreground) / <alpha-value>)",
          subtle: "rgb(var(--destructive-subtle) / <alpha-value>)",
          border: "rgb(var(--destructive-border) / <alpha-value>)",
        },
        popover: {
          DEFAULT: "rgb(var(--popover) / <alpha-value>)",
          foreground: "rgb(var(--popover-foreground) / <alpha-value>)",
        },
        card: {
          DEFAULT: "rgb(var(--card) / <alpha-value>)",
          foreground: "rgb(var(--card-foreground) / <alpha-value>)",
        },
        // Code/SQL — white card surface, ink text (JetBrains Mono).
        code: {
          DEFAULT: "rgb(var(--code-bg) / <alpha-value>)",
          foreground: "rgb(var(--code-foreground) / <alpha-value>)",
          border: "rgb(var(--code-border) / <alpha-value>)",
        },
        // AI-action timeline pastels — agent stages ONLY, never general UI.
        timeline: {
          thinking: "rgb(var(--timeline-thinking) / <alpha-value>)",
          grep: "rgb(var(--timeline-grep) / <alpha-value>)",
          read: "rgb(var(--timeline-read) / <alpha-value>)",
          edit: "rgb(var(--timeline-edit) / <alpha-value>)",
          done: "rgb(var(--timeline-done) / <alpha-value>)",
        },
      },
      borderRadius: {
        sm: "4px", // inline tags
        md: "8px", // buttons, inputs
        lg: "12px", // cards / panes / code / alerts
        xl: "12px", // cards (alias)
      },
      // Hairline-only depth — no drop shadows anywhere.
      boxShadow: {
        popover: "none",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};
