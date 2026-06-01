# Weft

Ask your data in plain English. Weft interviews you to build a semantic model over your warehouse, then answers questions with generated, verified queries. It refuses to make numbers up.

A weft is the set of threads woven across the warp to make fabric. That is what this does: it weaves scattered tables into a model you can actually ask questions of.

Built on [Malloy](https://www.malloydata.dev/) for the semantic layer. Works with BigQuery, Postgres, DuckDB, MySQL, and Snowflake. Runs three ways: a CLI, an [MCP](https://modelcontextprotocol.io/) server (so it works inside Cursor, Claude Desktop, Claude Code, or any MCP-capable IDE), and a local web app.

## What it does

Most "ask your data in English" tools are one LLM call wrapped in marketing. Weft is a pipeline with a check at every step where the model could lie.

1. **Introspect your warehouse once.** It reads schema, foreign keys, time ranges, and enum values, and writes a Malloy model per table.
2. **Design a semantic model for a purpose** ("product usage", "funnel") through a short interview. Weft reads your real schema and asks the decisions that matter: grain, identity, what counts as active, which measures. Every option is grounded in your actual columns and values.
3. **Ask questions against that model.** Weft picks a source, checks the question is answerable, generates Malloy, runs it, and verifies the result against your intent.
4. **Correct and refine.** Tell it an answer is wrong or a measure should change. It updates the model, shows the diff, and proves the change with the compiled SQL.

The point is the refusals. Weft checks feasibility before querying and verifies results after. If your data cannot answer a question, it says so. If a result looks wrong (a whole column of zeros, a count that should be distinct), it flags it instead of presenting it as fact.

## Why a semantic model, not raw SQL

Weft writes Malloy, not raw SQL. Malloy is a semantic layer: you define measures and dimensions once, and the agent composes queries from them. That is what makes answers trustworthy. The agent is not guessing at joins and grains every time. They are encoded in the model and compile-checked.

It also means one engine targets multiple warehouses. The same model compiles to BigQuery, Postgres, DuckDB, MySQL, or Snowflake SQL. Warehouse-specific behavior — billing, SQL dialect, type quirks, JSON/JSONB extraction — lives behind a single connector interface; the rest of the engine is warehouse-agnostic.

## The build contract

A model is only valid if every measure the interview decided on actually compiles. When a measure fails, Weft tries to repair it with the real compiler error. If it still fails, Weft reports it by name and marks the model incomplete. It never ships a broken model with a green checkmark. A build that compiles is also probed for empty or all-zero measures, so a model that compiles but is semantically wrong gets flagged, not shipped silently.

## Requirements

* Node.js 20+
* pnpm
* An Anthropic API key
* A warehouse: a BigQuery project (with `gcloud` auth), a Postgres/MySQL/Snowflake connection, or a local DuckDB/Parquet/CSV file

## Install

```bash
git clone https://github.com/githnm/weft.git
cd weft
pnpm install
pnpm build
```

## Environment

Set these in your shell or a `.env` file. See `.env.example`.

```bash
# Required
export ANTHROPIC_API_KEY="sk-ant-..."

# BigQuery
export BQ_PROJECT_ID="your-gcp-project"          # billing project
# auth via: gcloud auth application-default login

# Postgres
export POSTGRES_URL="postgresql://user:pass@host:5432/db?sslmode=no-verify"

# MySQL
export MYSQL_URL="mysql://user:pass@host:3306/db"

# DuckDB (a .duckdb file, or a Parquet/CSV file to read directly)
export DUCKDB_DATABASE="/absolute/path/to/data.duckdb"

# Snowflake
export SNOWFLAKE_ACCOUNT="org-account"
export SNOWFLAKE_USER="user"
export SNOWFLAKE_WAREHOUSE="WH"
export SNOWFLAKE_DATABASE="DB"
export SNOWFLAKE_PASSWORD="..."          # or SNOWFLAKE_PRIVATE_KEY_PATH for key-pair auth
```

The web app stores connections for you (see [The web app](#the-web-app)); the env vars above are for the CLI and MCP server.

Weft is read-only by design. It issues only `SELECT` and catalog queries. It never writes, creates, or drops anything. For extra safety against a production database, connect with a read-only role.

## Quick start: Postgres

```bash
# 1. Introspect (reads declared foreign keys from the catalog)
pnpm cli introspect \
  --connector postgres \
  --connection-string "$POSTGRES_URL" \
  --pg-schema public \
  --output ./substrate

# 2. Ask against the raw substrate
pnpm cli ask "how many users signed up last month?" \
  --models ./substrate \
  --show-malloy
```

## Quick start: BigQuery

Using the public Austin bikeshare dataset.

```bash
pnpm cli introspect \
  --connector bigquery \
  --project bigquery-public-data \
  --dataset austin_bikeshare \
  --output ./substrate \
  --billing-project "$BQ_PROJECT_ID" \
  --location US

pnpm cli ask "how many trips were taken by students?" \
  --models ./substrate \
  --billing-project "$BQ_PROJECT_ID" \
  --show-malloy
```

## Designing a semantic model

The substrate is a mechanical mirror of every table. The value is a model built for a purpose. The interview reads your schema and walks you through the decisions.

```bash
pnpm cli model design \
  --name product-usage \
  --purpose "Analyze how users engage with the product" \
  --substrate-dir ./substrate \
  --semantic-models-dir ./semantic-models
```

It proposes the relevant tables, then asks the decisions that matter, each with a recommended option grounded in your real schema. On real data it has caught things like identity ambiguity across anonymous and known users, picked the right join hub across many tables, and read actual enum values to define stages. Accept the recommendations for a clean first model, or deviate if you know your schema.

Then query the named model. Scoping to the model's tables makes answers more accurate and cheaper than querying the full schema.

```bash
pnpm cli ask "which workspaces have the most activity?" \
  --model product-usage \
  --semantic-models ./semantic-models \
  --show-malloy
```

## Correcting and refining

Fix a wrong answer:

```bash
pnpm cli correct "active users should exclude internal accounts" \
  --model product-usage --semantic-models ./semantic-models
```

Refine a model in plain English:

```bash
pnpm cli model refine product-usage \
  "add a measure for average events per active user" \
  --semantic-models-dir ./semantic-models
```

Both show the change and its impact before saving, and keep a one-step undo.

## Using it inside an IDE (MCP)

This is the intended way to use it day to day. Weft runs as an MCP server; your IDE drives the conversation.

Add to your IDE's MCP config (Claude Desktop: `~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "weft": {
      "command": "node",
      "args": ["/absolute/path/to/weft/dist/mcp/server.js"],
      "env": {
        "ANTHROPIC_API_KEY": "sk-ant-...",
        "POSTGRES_URL": "postgresql://user:pass@host:5432/db?sslmode=no-verify",
        "DEFAULT_MODELS_DIR": "/absolute/path/to/weft/substrate"
      }
    }
  }
}
```

Restart the IDE fully (quit, do not just close the window), then talk to it:

> Use my existing substrate. Design a semantic model for product usage with the recommended options, then tell me which workspaces have the most activity.

## The web app

A local web app wraps the same engine for people who would rather click than type CLI flags. Run it with:

```bash
pnpm --dir web install   # first time only
pnpm web                 # serves the app + API on localhost
```

Four screens:

* **Connections** — add and manage warehouse connections (BigQuery, Postgres, DuckDB, MySQL, Snowflake) from a form. Credentials are stored locally in `.weft/connections.json` (gitignored, `0600`) and never sent back to the browser — the UI only ever sees masked metadata. For BigQuery and Snowflake you point at a key file path, not key contents.
* **Models** — design a semantic model through the same interview, in a guided wizard. The Tables step shows every table in your substrate split into the AI's recommended set and everything else, each searchable and freely checkable; your final selection is authoritative through the build. A split-pane editor shows the model and its compiled output side by side.
* **Ask** — a conversational agent for asking questions and changing models. Model edits are proposed first and gated behind an explicit confirmation — it never writes silently. What-if simulations are reads and never touch the model.
* **Context** — an entity-centric graph of the model: sources, measures, dimensions, terms, and the decisions and corrections that shaped them.

## The context graph

Weft records the decisions it makes. Every ask, correction, refinement, and refusal is appended to a decision trace with its reasoning and outcome. Corrections link to the past answers they affect.

This is not just a log. You can ask what-if questions against it:

```bash
pnpm cli model whatif product-usage \
  "what if active_users required at least 2 events?" \
  --semantic-models-dir ./semantic-models
```

It finds the past questions that used the measure, re-runs them against the proposed change, and reports what would change, without touching the real model. The store is append-only JSONL, one trace per line.

## How it works

```
Warehouse (BigQuery / Postgres / DuckDB / MySQL / Snowflake)
        |
        v
   Introspection ---> substrate/   (schema, FKs, metadata, per-table .malloy)
        |
        v
   Interview --------> semantic-models/<name>/   (purpose-built, scoped model)
        |
        v
   Ask --------------> source select -> feasibility -> generate Malloy
                       -> execute -> verify result
        |
        v
   Correct / Refine -> update model, show diff + impact, undo available
        |
        v
   Context graph ----> decision traces + what-if simulation
```

Three layers of memory persist across questions: captured metadata (time bounds, enum values, ranges), business terms (your vocabulary mapped to filters), and session state (so follow-ups inherit context).

Five connectors (BigQuery, Postgres, DuckDB, MySQL, Snowflake) share one interface. Warehouse-specific behavior (billing, cost, SQL dialect, type quirks, JSON/JSONB extraction) lives behind the connector; the rest of the engine is warehouse-agnostic.

## Safety and trust

* **Read-only.** Only `SELECT` and catalog reads. Verify with `grep -rinE "(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER)" src/`.
* **Refuses fabrication.** A feasibility check runs before any query. If the model cannot answer, it explains what is missing.
* **Verifies results.** Every answer is checked structurally and against intent. Suspicious results (empty columns, wrong-looking counts) are flagged.
* **No silent edits.** Corrections and refinements show the diff and impact, and require confirmation.

## Gotchas

Things that will bite you, learned the hard way.

* **Supabase port.** Use the session pooler on port `5432`, not the transaction pooler on `6543`. The transaction pooler kills the catalog queries introspection needs.
* **Supabase host.** The direct connection (`db.<ref>.supabase.co`) is often IPv6-only and fails with `ENOTFOUND`. Use the session pooler host (`aws-N-<region>.pooler.supabase.com`) from the dashboard. Copy the exact region; do not guess it.
* **Cloud Postgres SSL.** Supabase, Neon, and RDS use certs that do not validate against the default chain. Use `?sslmode=no-verify`.
* **Introspect via CLI, not the IDE.** Introspection is a one-time, multi-minute operation. IDE tool calls time out. Run `introspect` from the terminal once; the IDE only reads the result.
* **Restart the IDE after a rebuild.** The MCP server is spawned once at IDE startup. After `pnpm build`, fully quit and reopen the IDE, or it runs stale code.
* **Region matters for BigQuery.** If your dataset is in EU, pass `--location EU`. The wrong region returns empty results that look like a bug.

## Costs

* BigQuery bills per byte scanned. Introspection samples large tables; a typical introspection costs a fraction of a cent.
* Postgres has no per-query cost, but introspection runs aggregate scans, so run it off-peak on a busy production database.
* Each question costs a few cents in LLM tokens. A correction costs slightly more (it re-runs the query to measure impact).

## Status

Working v1, validated end to end on real BigQuery, Postgres, and DuckDB databases through the CLI, MCP, and the web app, including a four-stage funnel across sessions, events, opportunities, and invoices. MySQL and Snowflake connectors are wired through the full stack and verified against live connection errors.

It is a solid foundation, not a finished commercial product. Known rough edges: complex cross-grain models can produce measures that compile but need refinement; the natural-language layer does not always auto-apply saved terms; unusual schemas will surface new cases. The engine tells you when it is unsure rather than hiding it. Bug reports and pull requests welcome.

## License

MIT. See [LICENSE](LICENSE).
