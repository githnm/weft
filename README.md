# Weft

Ask your data in plain English. Weft interviews you to build a semantic model over your warehouse, then answers questions with generated, verified queries. It refuses to make numbers up.

A weft is the set of threads woven across the warp to make fabric. That is what this does: it weaves scattered tables into a model you can actually ask questions of.

Built on [Malloy](https://www.malloydata.dev/) for the semantic layer. Works with BigQuery, Postgres, DuckDB, MySQL, and Snowflake. Runs three ways: a local web app, an [MCP](https://modelcontextprotocol.io/) server (so it works inside Claude Desktop, Cursor, or any MCP-capable client), and a CLI.

---

# Part 1 — Quickstart

A complete walkthrough: from `git clone` to asking questions in Claude Desktop, using the public **`bigquery-public-data.thelook_ecommerce`** dataset as the worked example. Follow the steps in order. Every command below was run against a fresh clone.

## 1. Prerequisites

You need:

- **Node.js 20+** and **pnpm** (`npm i -g pnpm`, or enable Corepack).
- **An Anthropic API key** — get one at <https://console.anthropic.com/settings/keys>.
- **For the BigQuery example:** a Google Cloud project with billing enabled, and application-default credentials set up:

```bash
gcloud auth application-default login
```

`thelook_ecommerce` is a free public dataset, but BigQuery still bills the *queries* to your own project — the introspection and each question scan a few MB and cost a fraction of a cent.

## 2. Clone and install

```bash
git clone https://github.com/githnm/weft.git
cd weft
pnpm install
```

One install covers both the engine and the web app — they're a single pnpm workspace. During install, pnpm prints a notice like `Ignored build scripts: esbuild` (and possibly `arrow2csv`); these are harmless and expected.

## 3. Set your API key in `.env`

Put the key in a gitignored `.env` file — **don't** `export` it in your shell. Shell exports go stale: if you later rotate the key, the old value lingers in the running shell and you get silent `401`s.

```bash
echo "ANTHROPIC_API_KEY=sk-ant-your-key-here" >> .env
```

Replace `sk-ant-your-key-here` with your real key. `.env` is already in `.gitignore` (the file lists `.env` and `.env.*`), so it will never be committed. Confirm:

```bash
grep -n '^.env' .gitignore
```

## 4. Build

```bash
pnpm build
```

This compiles the engine (`tsc`) and builds the web client (`vite`). Success looks like a `✓ built in …` line and no errors.

## 5. Start the web app

```bash
pnpm web
```

You'll see:

```
Weft web API listening on http://127.0.0.1:4000
Open http://127.0.0.1:4000
```

Open <http://127.0.0.1:4000> in your browser. Leave this running.

## 6. Connect a database

In the app, go to **Connections → Add connection**, choose **BigQuery**, and fill in the fields. BigQuery splits "who pays" from "where the data lives", so there are two project fields:

| Field | Value |
| --- | --- |
| **Project ID (billing)** | `your-gcp-billing-project` (the project queries are billed to) |
| **Data project (optional)** | `bigquery-public-data` (where the dataset lives) |
| **Dataset** | `thelook_ecommerce` |
| **Location** | `US` |
| **Service-account key file (optional)** | *leave blank* — uses your `gcloud` application-default credentials |

Click **Test connection**. On success it confirms the dataset is reachable. Then **Save connection**.

> Credentials are stored locally in `.weft/connections.json` (gitignored, owner-only `0600`) and never sent to the browser — the UI only ever sees masked metadata.

## 7. Introspect the dataset

On the connection card, click **Introspect**. This scans the dataset and builds the **substrate**: it lists tables, reads columns/types/foreign-keys, samples values, and writes a per-table `.malloy` file plus an `inspection.json` under `.weft/substrates/<connection-id>/`.

It runs as a background job with live progress (`listing tables → reading columns → reading tables (N of M) → writing substrate`). For `thelook_ecommerce` it's quick — seven tables: `distribution_centers`, `events`, `inventory_items`, `order_items`, `orders`, `products`, `users`. Wait until the connection shows **ready**.

## 8. Build a model

Go to **Models → Design new model**. The wizard has six steps:

1. **Datasource** — pick the `thelook_ecommerce` connection (it shows **ready**).
2. **Purpose** — describe what the model is for, e.g. `Analyze ecommerce sales, orders, and customers`.
3. **Tables** — Weft proposes the relevant tables (e.g. `orders`, `order_items`, `products`, `users`) and shows the rest below, searchable. Your selection is authoritative.
4. **Decisions** — Weft asks the modeling decisions that matter for *these* tables (grain, the revenue measure, identity), each with a recommended option grounded in your real columns. Accept the recommendations for a clean first model.
5. **Definitions** — optionally add business definitions now (you can also add them later).
6. **Build** — Weft generates the model, compiles every measure against BigQuery, repairs what it can, and saves it.

The result is a named semantic model saved under `.weft/models/<model-name>/` (a `model.malloy` plus its manifest). The model page shows its sources, measures, dimensions, a diagram, and the raw Malloy.

## 9. Connect to Claude Desktop via MCP

On the model page, open the **Connect via MCP** panel. It generates the exact config block with the correct absolute path to *this* clone's server already filled in. Click **Copy**. The block looks like:

```json
"weft": {
  "command": "node",
  "args": [
    "/absolute/path/to/weft/dist/mcp/server.js"
  ],
  "env": {
    "ANTHROPIC_API_KEY": "<your-key-here>"
  }
}
```

Now add it to your MCP client's config:

- **Claude Desktop (macOS):** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Claude Desktop (Windows):** `%APPDATA%\Claude\claude_desktop_config.json`
- **Claude Desktop (Linux):** `~/.config/Claude/claude_desktop_config.json`
- **Cursor:** `~/.cursor/mcp.json`

Paste the `"weft": { … }` entry **inside** the existing `mcpServers` object — don't replace the whole file, or you'll wipe out your other servers. If the file is empty or missing, wrap it:

```json
{
  "mcpServers": {
    "weft": {
      "command": "node",
      "args": ["/absolute/path/to/weft/dist/mcp/server.js"],
      "env": { "ANTHROPIC_API_KEY": "<your-key-here>" }
    }
  }
}
```

Then:

- Replace `<your-key-here>` with your Anthropic API key.
- **Validate the JSON** (a single typo silently breaks the whole config):

```bash
cat "$HOME/Library/Application Support/Claude/claude_desktop_config.json" | python3 -m json.tool
```

If it prints the parsed JSON, it's valid. If it errors, fix the JSON before continuing.

- **Fully quit Claude Desktop** (`Cmd+Q` on macOS — closing the window is not enough) and reopen it. The MCP server is spawned once at startup; a reload won't pick up the change.

> **Terminal alternative.** `pnpm mcp:config` prints the same block from the command line (as a full config file, with the absolute path filled in). The web panel is the easiest path; use the command if you prefer.

You don't configure a model path. Weft stores models and substrates under `WEFT_HOME` (default `<repo>/.weft`), resolved from the server's own location, so the MCP server finds your models no matter where Claude Desktop launches it. Warehouse credentials come from the connection you saved in the web app — they don't go in the config.

## 10. Ask questions in Claude Desktop

In a new Claude Desktop conversation, ask analytical questions. Weft picks a source, checks the question is answerable, generates Malloy, runs it against BigQuery, and verifies the result. With the `thelook_ecommerce` model:

**"Using weft, what's our revenue by month?"**

Revenue lives on `order_items.sale_price`, one grain below `orders` — Weft handles the fan-out join. The reply shows the question, the Malloy it generated, the result table, the BigQuery cost, and a verification block. You'll see something like:

The generated query:

```malloy
run: thelook_ecommerce -> {
  group_by: order_month is order_items.created_at.month
  aggregate: revenue is order_items.sale_price.sum()
  order_by: order_month
}
```

The result (one row per month):

| order_month | revenue    |
| ----------- | ---------- |
| 2023-01     | 412,883.50 |
| 2023-02     | 398,210.25 |
| …           | …          |

Followed by `Bytes scanned: 6.2 MB · BQ cost: $0.00003` and a **Verification** section ("returned one row per month, no null grouping keys, revenue positive"). Exact numbers depend on the dataset snapshot and how your model was built.

**"Show the top 10 products by revenue."** — joins `products` to `order_items`, sums `sale_price`, orders descending, limit 10.

**Define a term, then use it.** Definitions bake into the model so later questions reuse them:

> "Define a completed order as an order whose status is 'Complete'."

> "What's the revenue from completed orders this year?"

The second question applies the `completed order` definition automatically and shows the filter it added.

**A question Weft should refuse.** Ask something the data can't answer:

> "What was our marketing spend last quarter?"

`thelook_ecommerce` has no marketing/spend tables, so Weft declines instead of inventing a number:

```
## what was our marketing spend last quarter?

### Not Feasible
No table in this model contains marketing spend or cost data. The model
covers orders, order items, products, users, and events — there is no
spend/budget source to aggregate.

No query was executed. No BigQuery cost incurred.
```

That refusal is the point: Weft checks feasibility before querying and verifies results after, so you can trust the numbers it does return.

## 11. The Context Engine

Every question, definition, and correction is recorded as a decision trace. Open the **Context** screen (also called the Model Map) in the web app to see, at a glance:

- **What's been asked** — questions clustered around the measures and definitions they used.
- **Most used** — which measures people actually query, ranked by use.
- **Definitions** — the curated meaning layer (e.g. `completed order` and its aliases).
- **Gaps** — concepts people asked about that the model can't answer yet, surfaced as the top thing to add.

This is why the model improves as it's used: the questions reveal what's missing, the definitions accumulate the org's shared vocabulary, and the gaps tell you exactly what to model next. The context graph is the organization's analytical memory — not just a query log.

---

# Part 2 — How Weft works

## What it does

Most "ask your data in English" tools are one LLM call wrapped in marketing. Weft is a pipeline with a check at every step where the model could lie.

1. **Introspect your warehouse once.** It reads schema, foreign keys, time ranges, and enum values, and writes a Malloy model per table (the *substrate*).
2. **Design a semantic model for a purpose** through a short interview. Weft reads your real schema and asks the decisions that matter: grain, identity, which measures. Every option is grounded in your actual columns and values.
3. **Ask questions against that model.** Weft picks a source, checks the question is answerable, generates Malloy, runs it, and verifies the result against your intent.
4. **Correct and refine.** Tell it an answer is wrong or a measure should change. It updates the model, shows the diff, and proves the change with the compiled SQL.

The point is the refusals. Weft checks feasibility before querying and verifies results after. If your data cannot answer a question, it says so. If a result looks wrong (a whole column of zeros, a count that should be distinct), it flags it instead of presenting it as fact.

## Why a semantic model, not raw SQL

Weft writes Malloy, not raw SQL. Malloy is a semantic layer: you define measures and dimensions once, and the agent composes queries from them. That is what makes answers trustworthy — the agent is not guessing at joins and grains every time. They are encoded in the model and compile-checked.

It also means one engine targets multiple warehouses. The same model compiles to BigQuery, Postgres, DuckDB, MySQL, or Snowflake SQL. Warehouse-specific behavior — billing, SQL dialect, type quirks, JSON/JSONB extraction — lives behind a single connector interface; the rest of the engine is warehouse-agnostic.

## The build contract

A model is only valid if every measure the interview decided on actually compiles. When a measure fails, Weft tries to repair it with the real compiler error. If it still fails, Weft reports it by name and marks the model incomplete. It never ships a broken model with a green checkmark. A build that compiles is also probed for empty or all-zero measures, so a model that compiles but is semantically wrong gets flagged, not shipped silently.

## Architecture

```
Warehouse (BigQuery / Postgres / DuckDB / MySQL / Snowflake)
        |
        v
   Introspection ---> substrate     (schema, FKs, metadata, per-table .malloy)
        |
        v
   Interview --------> model         (purpose-built, scoped semantic model)
        |
        v
   Ask --------------> source select -> feasibility -> generate Malloy
                       -> execute -> verify result
        |
        v
   Correct / Refine -> update model, show diff + impact, undo available
        |
        v
   Context engine ---> decision traces + what-if simulation
```

Everything Weft keeps lives under one root, **`WEFT_HOME`** (default `<repo>/.weft`):

```
.weft/
├── connections.json        saved warehouse connections (secrets, 0600)
├── substrates/<conn-id>/   per-connection introspection output
└── models/<name>/          built semantic models
```

`WEFT_HOME` is resolved from the running code's own location, not the current directory — so the web app, the CLI, and the MCP server all agree on where models live with no path configuration. Set `WEFT_HOME` only if you want to relocate that directory.

Three layers of memory persist across questions: captured metadata (time bounds, enum values, ranges), business terms (your vocabulary mapped to filters), and session state (so follow-ups inherit context).

## Safety and trust

- **Read-only.** Only `SELECT` and catalog reads. Verify with `grep -rinE "(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER)" src/`. For extra safety against a production database, connect with a read-only role.
- **Refuses fabrication.** A feasibility check runs before any query. If the model cannot answer, it explains what is missing.
- **Verifies results.** Every answer is checked structurally and against intent. Suspicious results (empty columns, wrong-looking counts) are flagged.
- **No silent edits.** Corrections and refinements show the diff and impact, and require confirmation.

## Using the CLI

The web app is the easiest path, but the same engine runs from the terminal. The CLI uses the same `WEFT_HOME` convention, so models you build either way are shared.

```bash
# Introspect a dataset → substrate (BigQuery example)
pnpm cli introspect \
  --connector bigquery \
  --project bigquery-public-data \
  --dataset thelook_ecommerce \
  --billing-project "$BQ_PROJECT_ID" \
  --location US

# Design a model through the interview
pnpm cli model design \
  --name ecommerce \
  --purpose "Analyze ecommerce sales, orders, and customers"

# Ask against the named model
pnpm cli ask "what is revenue by month?" --model ecommerce --show-malloy

# Correct an answer, or refine a model in plain English
pnpm cli correct "revenue should exclude returned orders" --model ecommerce
pnpm cli model refine ecommerce "add average order value"
```

Corrections and refinements show the change and its impact before saving, and keep a one-step undo. `pnpm cli model whatif <name> "..."` re-runs past questions against a proposed change without touching the real model.

## Troubleshooting

**`401` / `invalid x-api-key`.** Your Anthropic key is wrong, expired, or rotated. Check `.env` has the current key. If you ever `export`ed it, the stale value overrides `.env` — check and clear it:

```bash
echo "$ANTHROPIC_API_KEY"     # should be empty if you only use .env
unset ANTHROPIC_API_KEY
```

Then restart `pnpm web` (and, for MCP, fully quit and reopen Claude Desktop).

**MCP lists no models.** Usually one of:
- The config points at the wrong clone — `args` must be the absolute path to *this* checkout's `dist/mcp/server.js`. Re-run `pnpm mcp:config` or the **Connect via MCP** panel to get the correct path.
- The JSON is malformed — validate it: `cat <config-path> | python3 -m json.tool`.
- Claude Desktop wasn't fully quit — `Cmd+Q` and reopen, not just close the window.
- You haven't built a model yet — build one in the web app, then it appears.

**`pnpm web` fails with "cannot find module" errors.** The web client's dependencies aren't installed. Run `pnpm install` from the **repo root** (it's a workspace; one root install covers both packages), then `pnpm build`.

**BigQuery returns empty results that look like a bug.** Check the dataset's region. If it's in EU, set **Location** to `EU` (the wrong region silently returns nothing).

## Costs

- BigQuery bills per byte scanned. Introspection samples large tables; a typical introspection costs a fraction of a cent. Each question scans a few MB.
- Postgres/MySQL have no per-query cost, but introspection runs aggregate scans — run it off-peak on a busy production database.
- Each question costs a few cents in Anthropic tokens. A correction costs slightly more (it re-runs the query to measure impact).

## Status

Working v1, validated end to end on real BigQuery, Postgres, and DuckDB databases through the CLI, MCP, and the web app. MySQL and Snowflake connectors are wired through the full stack and verified against live connection errors.

It is a solid foundation, not a finished commercial product. Known rough edges: complex cross-grain models can produce measures that compile but need refinement; the natural-language layer does not always auto-apply saved terms; unusual schemas will surface new cases. The engine tells you when it is unsure rather than hiding it. Bug reports and pull requests welcome.

## License

MIT. See [LICENSE](LICENSE).
