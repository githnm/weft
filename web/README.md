# Weft — web client

Vite + React + Tailwind + shadcn/ui (new-york style). Light mode only, Supabase-flavored:
thin borders for structure, one restrained green accent, no shadows, no dark mode.

```bash
pnpm install
pnpm dev      # http://localhost:5173
pnpm build    # type-check (tsc -b) + production build
```

## Layout

- `src/index.css` — design tokens (CSS variables). Light mode only; edit the green at `--primary`.
- `src/components/ui/` — shadcn primitives (button, input, textarea, card, table, badge, separator).
- `src/components/` — app pieces: `app-sidebar`, `progress-stages`, `verification-callout`, `malloy-block`, `results-table`.
- `src/screens/` — `ask` (the centerpiece), `models` and `context` (stubs, same tokens).

## Wiring to the engine

The Ask screen currently runs a **front-end simulation** (`runAsk` in `src/screens/ask.tsx`) with
fictional sample data. To connect it to the real engine, replace that function with a call to an
HTTP/SSE endpoint wrapping the `ask` pipeline (or the MCP `ask_question` tool) and stream the stage
events + `AskResult` into the same components — `ProgressStages`, `ResultsTable`, `MalloyBlock`,
and `VerificationCallout` already model the engine's output shape.
