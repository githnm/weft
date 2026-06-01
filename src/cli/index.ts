import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { createConnector } from "../connectors/factory.js";
import { runIntrospect, runRefreshMetadata } from "./commands/introspect.js";
import { runGenerate } from "./commands/generate.js";
import { runVerify } from "./commands/verify.js";
import { runSuggest } from "./commands/suggest.js";
import { runAsk } from "./commands/ask.js";
import { runDefineConfirm, runDefineManual } from "./commands/define.js";
import { runTermsList, runTermsDelete, runTermsShow } from "./commands/terms.js";
import { runSessionShow, runSessionClear } from "./commands/session.js";
import { runCorrect } from "./commands/correct.js";
import { runCorrectionsList, runCorrectionsShow, runCorrectionsRollback } from "./commands/corrections.js";
import { runModelCreate, runModelList, runModelShow, runModelDelete, runModelTables } from "./commands/model.js";
import { runModelDesign } from "./commands/design.js";
import { runModelRefine, runModelRevert } from "./commands/refine.js";
import { runModelWhatif } from "./commands/whatif.js";
import { runContextGraph } from "./commands/graph.js";
import { resolveSubstrateDir, resolveSemanticModelsDir } from "../models/manifest.js";

/** Detect connector kind from inspection.json in a directory. */
async function detectConnectorKind(dir: string): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(path.join(dir, "inspection.json"), "utf-8");
    return JSON.parse(raw).connector_kind;
  } catch {
    return undefined;
  }
}

const program = new Command();

program
  .name("agentic-analytics")
  .description("Agentic analytics engine CLI")
  .version("0.1.0");

program
  .command("introspect")
  .description("Introspect a warehouse dataset and generate Malloy model files")
  .option("--output <dir>", "Output directory for generated files (default: $WEFT_HOME/substrate)")
  .option("--connector <type>", "Connector type: bigquery, postgres, duckdb, mysql, or snowflake", "bigquery")
  .option("--project <project>", "GCP project that owns the dataset (BigQuery)")
  .option("--dataset <dataset>", "BigQuery dataset name (BigQuery)")
  .option("--billing-project <project>", "GCP project for billing (defaults to BQ_PROJECT_ID env var)")
  .option("--location <region>", "BigQuery dataset region (e.g. US, EU, asia-northeast1)", "US")
  .option("--connection-string <url>", "Postgres/MySQL connection string (postgres://… or mysql://…)")
  .option("--pg-schema <schema>", "Postgres schema to introspect (default: public)", "public")
  .option("--file <path>", "DuckDB file path — a .duckdb file or a Parquet/CSV (DuckDB connector)")
  .option("--sf-account <account>", "Snowflake account identifier (org-account, e.g. myorg-myaccount)")
  .option("--sf-user <user>", "Snowflake username")
  .option("--sf-warehouse <wh>", "Snowflake warehouse")
  .option("--sf-database <db>", "Snowflake database")
  .option("--sf-schema <schema>", "Snowflake schema (default: PUBLIC)", "PUBLIC")
  .option("--sf-role <role>", "Snowflake role (optional)")
  .option("--sf-password <pw>", "Snowflake password (or use --sf-key for key-pair auth)")
  .option("--sf-key <path>", "Snowflake private key file path (key-pair auth)")
  .option("--sample-rows <n>", "Number of sample rows per table", "1000")
  .option("--exclude-enum <columns...>", "Force-skip enum capture for these table.column pairs (e.g. bikeshare_stations.address)")
  .action(async (opts: {
    output?: string;
    connector: string;
    project?: string;
    dataset?: string;
    billingProject?: string;
    location: string;
    connectionString?: string;
    pgSchema: string;
    file?: string;
    sfAccount?: string;
    sfUser?: string;
    sfWarehouse?: string;
    sfDatabase?: string;
    sfSchema: string;
    sfRole?: string;
    sfPassword?: string;
    sfKey?: string;
    sampleRows: string;
    excludeEnum?: string[];
  }) => {
    try {
      const outputDir = opts.output ?? resolveSubstrateDir();
      let connector;

      if (opts.connector === "duckdb") {
        const filePath = opts.file ?? process.env.DUCKDB_DATABASE;
        if (!filePath) {
          console.error(
            "Error: --file or DUCKDB_DATABASE must be set for the DuckDB connector.\n" +
              "Point at a .duckdb file or a Parquet/CSV — no server needed.\n" +
              "Example: --connector duckdb --file ./data/events.parquet",
          );
          process.exit(1);
        }
        connector = createConnector({ kind: "duckdb", filePath });
      } else if (opts.connector === "mysql") {
        const connectionString = opts.connectionString ?? process.env.MYSQL_URL;
        if (!connectionString) {
          console.error(
            "Error: --connection-string or MYSQL_URL must be set for the MySQL connector.\n" +
              "Example: --connection-string mysql://user:pass@host:3306/mydb",
          );
          process.exit(1);
        }
        connector = createConnector({ kind: "mysql", connectionString });
      } else if (opts.connector === "snowflake") {
        const account = opts.sfAccount ?? process.env.SNOWFLAKE_ACCOUNT;
        const username = opts.sfUser ?? process.env.SNOWFLAKE_USER;
        const warehouse = opts.sfWarehouse ?? process.env.SNOWFLAKE_WAREHOUSE;
        const database = opts.sfDatabase ?? process.env.SNOWFLAKE_DATABASE;
        if (!account || !username || !warehouse || !database) {
          console.error(
            "Error: Snowflake requires --sf-account, --sf-user, --sf-warehouse, --sf-database (or the SNOWFLAKE_* env vars).",
          );
          process.exit(1);
        }
        connector = createConnector({
          kind: "snowflake",
          account, username, warehouse, database,
          schema: opts.sfSchema,
          role: opts.sfRole,
          password: opts.sfPassword ?? process.env.SNOWFLAKE_PASSWORD,
          privateKeyPath: opts.sfKey ?? process.env.SNOWFLAKE_PRIVATE_KEY_PATH,
          privateKeyPassphrase: process.env.SNOWFLAKE_PRIVATE_KEY_PASSPHRASE,
        });
      } else if (opts.connector === "postgres") {
        const connectionString = opts.connectionString ?? process.env.POSTGRES_URL;
        if (!connectionString) {
          console.error(
            "Error: --connection-string or POSTGRES_URL must be set for the Postgres connector.\n" +
              "Example: --connection-string postgres://user:pass@host:5432/mydb?sslmode=require\n" +
              "     Or: export POSTGRES_URL=postgres://user:pass@host:5432/mydb?sslmode=require"
          );
          process.exit(1);
        }
        connector = createConnector({
          kind: "postgres",
          connectionString,
          schema: opts.pgSchema,
        });
      } else {
        // BigQuery (default)
        if (!opts.project) {
          console.error("Error: --project is required for the BigQuery connector.");
          process.exit(1);
        }
        if (!opts.dataset) {
          console.error("Error: --dataset is required for the BigQuery connector.");
          process.exit(1);
        }
        const billingProject = opts.billingProject ?? process.env.BQ_PROJECT_ID;
        if (!billingProject) {
          console.error(
            "Error: --billing-project or BQ_PROJECT_ID must be set.\n" +
              "This is the GCP project billed for BigQuery queries.\n" +
              "Example: --billing-project my-project  or  export BQ_PROJECT_ID=my-project"
          );
          process.exit(1);
        }
        connector = createConnector({
          kind: "bigquery",
          project: opts.project,
          dataset: opts.dataset,
          billingProject,
          location: opts.location,
        });
      }

      await runIntrospect(connector, outputDir, {
        sampleRows: parseInt(opts.sampleRows, 10),
        excludeEnums: opts.excludeEnum,
      });

      // Clean up connector resources
      await connector.close();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);

      if (message.includes("Could not load the default credentials") || message.includes("PERMISSION_DENIED") || message.includes("Request had insufficient authentication scopes")) {
        console.error("\nBigQuery auth error:\n");
        console.error(message);
        console.error(
          "\nHint: make sure GOOGLE_APPLICATION_CREDENTIALS points to a valid service-account key,\n" +
            "or run `gcloud auth application-default login`.\n" +
            "Verify BQ_PROJECT_ID is set to a project with BigQuery API enabled."
        );
      } else if (message.includes("Not found: Dataset")) {
        console.error("\nDataset not found:\n");
        console.error(message);
        console.error("\nHint: check --project and --dataset values. For public datasets, --project is the owning project (e.g. bigquery-public-data).");
      } else if (message.includes("ECONNREFUSED") || message.includes("ETIMEDOUT") || message.includes("ENOTFOUND")) {
        console.error("\nPostgres connection error:\n");
        console.error(message);
        console.error(
          "\nHint: check the connection string, hostname, port, and that the database is reachable.\n" +
            "For cloud Postgres, ensure SSL is configured (sslmode=require in the connection string)."
        );
      } else if (message.includes("password authentication failed") || message.includes("no pg_hba.conf entry")) {
        console.error("\nPostgres auth error:\n");
        console.error(message);
        console.error(
          "\nHint: check the username and password in the connection string.\n" +
            "For cloud providers, use the database-specific credentials (not your cloud account password)."
        );
      } else if (message.includes("SSL") || message.includes("self-signed certificate") || message.includes("self signed certificate")) {
        console.error("\nPostgres SSL error:\n");
        console.error(message);
        console.error(
          "\nHint: add ?sslmode=require to the connection string.\n" +
            "Cloud Postgres providers (Supabase, Neon, RDS) typically require SSL."
        );
      } else {
        console.error("\nUnexpected error:\n");
        console.error(err instanceof Error ? err.stack ?? message : message);
      }
      process.exit(1);
    }
  });

program
  .command("generate")
  .description("Re-run Pass B from an existing inspection.json (no BigQuery queries)")
  .requiredOption("--from <path>", "Path to inspection.json")
  .requiredOption("--output <dir>", "Output directory for generated files")
  .action(async (opts: { from: string; output: string }) => {
    try {
      await runGenerate({ from: opts.from, outputDir: opts.output });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("\nError:\n");
      console.error(message);
      process.exit(1);
    }
  });

program
  .command("verify")
  .description("Compile all .malloy model files and report parse/compile errors")
  .requiredOption("--models <dir>", "Directory containing .malloy files")
  .option("--billing-project <project>", "GCP project for billing (defaults to BQ_PROJECT_ID env var)")
  .action(async (opts: { models: string; billingProject?: string }) => {
    const billingProject = opts.billingProject ?? process.env.BQ_PROJECT_ID;
    if (!billingProject) {
      console.error(
        "Error: --billing-project or BQ_PROJECT_ID must be set.\n" +
          "The Malloy compiler resolves table schemas from BigQuery metadata.\n" +
          "Example: --billing-project my-project  or  export BQ_PROJECT_ID=my-project"
      );
      process.exit(1);
    }

    try {
      await runVerify({ modelsDir: opts.models, billingProject });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("Could not load the default credentials") || message.includes("PERMISSION_DENIED")) {
        console.error("\nBigQuery auth error:\n");
        console.error(message);
        console.error(
          "\nHint: the verify command needs BigQuery access to resolve table schemas.\n" +
            "Run `gcloud auth application-default login` or set GOOGLE_APPLICATION_CREDENTIALS."
        );
      } else {
        console.error("\nUnexpected error:\n");
        console.error(err instanceof Error ? err.stack ?? message : message);
      }
      process.exit(1);
    }
  });

program
  .command("suggest")
  .description("Use an LLM to suggest additional measures, views, and filters")
  .requiredOption("--models <dir>", "Directory containing .malloy files and inspection.json")
  .option("--max-suggestions <n>", "Maximum number of suggestions", "15")
  .option("--billing-project <project>", "GCP project for billing (defaults to BQ_PROJECT_ID env var)")
  .action(async (opts: { models: string; maxSuggestions: string; billingProject?: string }) => {
    const billingProject = opts.billingProject ?? process.env.BQ_PROJECT_ID;
    if (!billingProject) {
      console.error(
        "Error: --billing-project or BQ_PROJECT_ID must be set.\n" +
          "Suggestion validation compiles Malloy models which resolve table schemas.\n" +
          "Example: --billing-project my-project  or  export BQ_PROJECT_ID=my-project"
      );
      process.exit(1);
    }

    try {
      await runSuggest({
        modelsDir: opts.models,
        maxSuggestions: parseInt(opts.maxSuggestions, 10),
        billingProject,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("ANTHROPIC_API_KEY")) {
        console.error(`\n${message}`);
      } else if (message.includes("Could not parse")) {
        console.error("\nLLM response parse error:\n");
        console.error(message);
      } else {
        console.error("\nError:\n");
        console.error(err instanceof Error ? err.stack ?? message : message);
      }
      process.exit(1);
    }
  });

program
  .command("ask")
  .description("Ask a natural-language question and get results from BigQuery via Malloy")
  .argument("<question>", "Natural-language question to answer")
  .option("--models <dir>", "Directory containing .malloy files (default: $WEFT_HOME/substrate)")
  .option("--model <name>", "Named semantic model to query (e.g. 'sales'). Only that model's tables are visible.")
  .option("--semantic-models <dir>", "Parent directory for semantic models (default: $WEFT_HOME/models)")
  .option("--billing-project <project>", "GCP project for billing (defaults to BQ_PROJECT_ID env var)")
  .option("--source <source>", "Skip source selection; use this source directly")
  .option("--show-malloy", "Print the generated Malloy query")
  .option("--dry-run", "Generate and compile the query but do not execute it")
  .option("--skip-feasibility", "Skip the feasibility check (allow hypothetical questions)")
  .option("--no-verify", "Skip both verification layers")
  .option("--no-llm-verify", "Skip the LLM semantic check (layer 2); structural checks still run")
  .option("--strict", "Exit code 1 if verification finds warnings or intent mismatch")
  .option("--verbose", "Show full stack traces on errors")
  .option("--location <region>", "BigQuery dataset region (e.g. US, EU, asia-northeast1)", "US")
  .option("--new-session", "Clear session state before running (treat as fresh question)")
  .option("--no-session", "Ignore session state entirely (don't load, don't update)")
  .action(async (question: string, opts: {
    models?: string;
    model?: string;
    semanticModels?: string;
    billingProject?: string;
    source?: string;
    showMalloy?: boolean;
    dryRun?: boolean;
    skipFeasibility?: boolean;
    verify?: boolean;
    llmVerify?: boolean;
    strict?: boolean;
    verbose?: boolean;
    location: string;
    newSession?: boolean;
    session?: boolean;
  }) => {
    const billingProject = opts.billingProject ?? process.env.BQ_PROJECT_ID;
    if (!billingProject) {
      console.error(
        "Error: --billing-project or BQ_PROJECT_ID must be set.\n" +
          "Example: --billing-project my-project  or  export BQ_PROJECT_ID=my-project"
      );
      process.exit(1);
    }

    // Resolve models directory: --model takes precedence over --models
    let modelsDir: string;
    if (opts.model) {
      const semanticModelsDir = resolveSemanticModelsDir(opts.semanticModels);
      modelsDir = path.resolve(path.join(semanticModelsDir, opts.model));
    } else {
      modelsDir = opts.models ?? resolveSubstrateDir();
    }

    try {
      await runAsk({
        question,
        modelsDir,
        billingProject,
        location: opts.location,
        sourceOverride: opts.source,
        showMalloy: opts.showMalloy,
        dryRun: opts.dryRun,
        skipFeasibility: opts.skipFeasibility,
        noVerify: opts.verify === false,
        noLlmVerify: opts.llmVerify === false,
        strict: opts.strict,
        verbose: opts.verbose,
        newSession: opts.newSession,
        noSession: opts.session === false,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("ANTHROPIC_API_KEY")) {
        console.error(`\n  ${message}`);
      } else if (message.includes("Could not load the default credentials") || message.includes("PERMISSION_DENIED")) {
        console.error("\n  BigQuery auth error:");
        console.error(`  ${message}`);
        console.error(
          "\n  Hint: run `gcloud auth application-default login` or set GOOGLE_APPLICATION_CREDENTIALS."
        );
      } else {
        console.error(`\n  Error: ${message}`);
        if (opts.verbose && err instanceof Error && err.stack) {
          console.error("");
          console.error(err.stack);
        }
      }
      process.exit(1);
    }
  });

program
  .command("refresh-metadata")
  .description("Re-generate metadata.json from an existing inspection.json (no BigQuery queries)")
  .requiredOption("--models <dir>", "Directory containing inspection.json")
  .action(async (opts: { models: string }) => {
    try {
      await runRefreshMetadata({ modelsDir: opts.models });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`\nError:\n`);
      console.error(message);
      process.exit(1);
    }
  });

// ── Define command ───────────────────────────────────────────
program
  .command("define")
  .description("Define a business term as a Malloy filter expression")
  .argument("<term>", "The term to define (e.g. 'students')")
  .option("--confirm", "Confirm a pending auto-proposed term")
  .option("--description <desc>", "Description of the term (for manual mode)")
  .option("--source <file>", "Source .malloy filename to attach the term to")
  .option("--model <name>", "Named semantic model to attach the term to (terms save in that model's dir, where 'ask --model' reads them)")
  .option("--semantic-models <dir>", "Parent directory for semantic models (default: $WEFT_HOME/models)")
  .option("--models <dir>", "Directory containing .malloy files (default: $WEFT_HOME/substrate). Ignored when --model is set.")
  .option("--billing-project <project>", "GCP project for billing (defaults to BQ_PROJECT_ID env var)")
  .action(async (term: string, opts: {
    confirm?: boolean;
    description?: string;
    source?: string;
    model?: string;
    semanticModels?: string;
    models?: string;
    billingProject?: string;
  }) => {
    // Resolve the target dir the same way `ask` does: --model points at the
    // semantic model's own dir (where ask reads its terms), else --models.
    let modelsDir: string;
    if (opts.model) {
      const semanticModelsDir = resolveSemanticModelsDir(opts.semanticModels);
      modelsDir = path.resolve(path.join(semanticModelsDir, opts.model));
    } else {
      modelsDir = opts.models ?? resolveSubstrateDir();
    }

    const billingProject = opts.billingProject ?? process.env.BQ_PROJECT_ID;
    // Connector-aware: BigQuery needs a billing project, Postgres does not.
    const connectorKind = await detectConnectorKind(modelsDir);
    if (connectorKind === "bigquery" && !billingProject) {
      console.error(
        "Error: --billing-project or BQ_PROJECT_ID must be set for BigQuery models.\n" +
          "Example: --billing-project my-project  or  export BQ_PROJECT_ID=my-project"
      );
      process.exit(1);
    }

    if (opts.confirm) {
      await runDefineConfirm({ term, modelsDir, billingProject });
    } else {
      if (!opts.description) {
        console.error("Error: --description is required for manual term definition.");
        console.error("Usage: pnpm cli define <term> --description \"...\" --model <name>");
        console.error("   Or: pnpm cli define <term> --confirm --model <name>");
        process.exit(1);
      }
      await runDefineManual({
        term,
        description: opts.description,
        source: opts.source,
        modelsDir,
        billingProject,
      });
    }
  });

// ── Terms command ────────────────────────────────────────────
const termsCmd = program
  .command("terms")
  .description("Manage business term mappings");

termsCmd
  .command("list")
  .description("List all confirmed terms and pending proposals")
  .requiredOption("--models <dir>", "Directory containing terms.json")
  .action(async (opts: { models: string }) => {
    await runTermsList({ modelsDir: opts.models });
  });

termsCmd
  .command("show")
  .description("Show full details for a term")
  .argument("<term>", "The term key to show")
  .requiredOption("--models <dir>", "Directory containing terms.json")
  .action(async (term: string, opts: { models: string }) => {
    await runTermsShow({ term, modelsDir: opts.models });
  });

termsCmd
  .command("delete")
  .description("Delete a confirmed term")
  .argument("<term>", "The term key to delete")
  .requiredOption("--models <dir>", "Directory containing terms.json")
  .action(async (term: string, opts: { models: string }) => {
    await runTermsDelete({ term, modelsDir: opts.models });
  });

// ── Session command ──────────────────────────────────────────
const sessionCmd = program
  .command("session")
  .description("Manage session state for follow-up questions");

sessionCmd
  .command("show")
  .description("Print current session state")
  .requiredOption("--models <dir>", "Directory containing session.json")
  .action(async (opts: { models: string }) => {
    await runSessionShow({ modelsDir: opts.models });
  });

sessionCmd
  .command("clear")
  .description("Clear session state")
  .requiredOption("--models <dir>", "Directory containing session.json")
  .action(async (opts: { models: string }) => {
    await runSessionClear({ modelsDir: opts.models });
  });

// ── Correct command ──────────────────────────────────────────
program
  .command("correct")
  .description("Apply a correction to a term or suggest a model edit")
  .argument("<text>", "Correction text (e.g. 'students should exclude trips under 2 min')")
  .option("--model <name>", "Named semantic model to correct (e.g. 'product_usage'). Only that model's dir is used.")
  .option("--semantic-models <dir>", "Parent directory for semantic models (default: $WEFT_HOME/models)")
  .option("--models <dir>", "Directory containing .malloy files (default: $WEFT_HOME/substrate). Ignored when --model is set.")
  .option("--billing-project <project>", "GCP project for billing (defaults to BQ_PROJECT_ID env var)")
  .option("--source <source>", "Target source file (auto-detected from session if omitted)")
  .option("--no-impact", "Skip numeric impact calculation (faster)")
  .action(async (text: string, opts: {
    model?: string;
    semanticModels?: string;
    models?: string;
    billingProject?: string;
    source?: string;
    impact?: boolean;
  }) => {
    // Resolve models directory the same way `ask` does: --model takes
    // precedence and points at the semantic model's own dir (where its
    // session.json and traces.jsonl live), otherwise fall back to --models.
    let modelsDir: string;
    if (opts.model) {
      const semanticModelsDir = resolveSemanticModelsDir(opts.semanticModels);
      modelsDir = path.resolve(path.join(semanticModelsDir, opts.model));
    } else {
      modelsDir = opts.models ?? resolveSubstrateDir();
    }

    const billingProject = opts.billingProject ?? process.env.BQ_PROJECT_ID;

    // Connector-aware billing gate: BigQuery needs a billing project, Postgres
    // does not. For a semantic model, read connector_kind from its manifest
    // (falling back to the substrate's inspection.json); otherwise read the
    // dir's inspection.json directly.
    let connectorKind: string | undefined;
    try {
      const manifestRaw = await fs.readFile(path.join(modelsDir, "model.json"), "utf-8");
      const manifest = JSON.parse(manifestRaw);
      connectorKind = manifest.connector_kind;
      if (!connectorKind) {
        const substrateDir = path.resolve(modelsDir, manifest.substrate_dir);
        connectorKind = await detectConnectorKind(substrateDir);
      }
    } catch {
      connectorKind = await detectConnectorKind(modelsDir);
    }

    if (connectorKind === "bigquery" && !billingProject) {
      console.error(
        "Error: --billing-project or BQ_PROJECT_ID must be set for BigQuery models.\n" +
          "Example: --billing-project my-project  or  export BQ_PROJECT_ID=my-project"
      );
      process.exit(1);
    }

    try {
      await runCorrect({
        correctionText: text,
        modelsDir,
        billingProject,
        source: opts.source,
        skipImpact: opts.impact === false,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`\n  Error: ${message}\n`);
      process.exit(1);
    }
  });

// ── Corrections command ─────────────────────────────────────
const correctionsCmd = program
  .command("corrections")
  .description("View and manage applied corrections");

correctionsCmd
  .command("list")
  .description("List all applied corrections")
  .requiredOption("--models <dir>", "Directory containing corrections.json")
  .action(async (opts: { models: string }) => {
    await runCorrectionsList({ modelsDir: opts.models });
  });

correctionsCmd
  .command("show")
  .description("Show full details for a correction")
  .argument("<id>", "The correction ID")
  .requiredOption("--models <dir>", "Directory containing corrections.json")
  .action(async (id: string, opts: { models: string }) => {
    await runCorrectionsShow({ correctionId: id, modelsDir: opts.models });
  });

correctionsCmd
  .command("rollback")
  .description("Rollback a term_update correction (restores old filter)")
  .argument("<id>", "The correction ID to rollback")
  .requiredOption("--models <dir>", "Directory containing corrections.json")
  .action(async (id: string, opts: { models: string }) => {
    await runCorrectionsRollback({ correctionId: id, modelsDir: opts.models });
  });

// ── Model command ──────────────────────────────────────────────
const modelCmd = program
  .command("model")
  .description("Manage named semantic models (purpose-scoped subsets of the substrate)");

modelCmd
  .command("create")
  .description("Create a semantic model from a subset of substrate tables")
  .requiredOption("--name <name>", "Name for the model (becomes directory name)")
  .requiredOption("--purpose <purpose>", "One-line purpose description")
  .requiredOption("--tables <tables...>", "Table names to include (must exist in substrate)")
  .option("--substrate-dir <dir>", "Path to substrate directory (default: $WEFT_HOME/substrate)")
  .option("--semantic-models-dir <dir>", "Path to semantic-models directory (default: $WEFT_HOME/models)")
  .action(async (opts: {
    name: string;
    purpose: string;
    tables: string[];
    substrateDir?: string;
    semanticModelsDir?: string;
  }) => {
    try {
      await runModelCreate(opts);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`\n  Error: ${message}\n`);
      process.exit(1);
    }
  });

modelCmd
  .command("list")
  .description("List all semantic models")
  .option("--semantic-models-dir <dir>", "Path to semantic-models directory (default: $WEFT_HOME/models)")
  .action(async (opts: { semanticModelsDir?: string }) => {
    try {
      await runModelList(opts);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`\n  Error: ${message}\n`);
      process.exit(1);
    }
  });

modelCmd
  .command("show")
  .description("Show detailed information about a semantic model")
  .argument("<name>", "Name of the model")
  .option("--semantic-models-dir <dir>", "Path to semantic-models directory (default: $WEFT_HOME/models)")
  .action(async (name: string, opts: { semanticModelsDir?: string }) => {
    try {
      await runModelShow({ name, ...opts });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`\n  Error: ${message}\n`);
      process.exit(1);
    }
  });

modelCmd
  .command("delete")
  .description("Delete a semantic model (does not affect the substrate)")
  .argument("<name>", "Name of the model to delete")
  .option("--semantic-models-dir <dir>", "Path to semantic-models directory (default: $WEFT_HOME/models)")
  .action(async (name: string, opts: { semanticModelsDir?: string }) => {
    try {
      await runModelDelete({ name, ...opts });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`\n  Error: ${message}\n`);
      process.exit(1);
    }
  });

modelCmd
  .command("tables")
  .description("List tables available in the substrate for model creation")
  .option("--substrate-dir <dir>", "Path to substrate directory (default: $WEFT_HOME/substrate)")
  .action(async (opts: { substrateDir?: string }) => {
    try {
      await runModelTables(opts);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`\n  Error: ${message}\n`);
      process.exit(1);
    }
  });

modelCmd
  .command("design")
  .description("Design a semantic model interactively — the LLM proposes tables and decisions, you resolve them")
  .requiredOption("--name <name>", "Name for the model (becomes directory name)")
  .requiredOption("--purpose <purpose>", "One-line purpose description")
  .option("--substrate-dir <dir>", "Path to substrate directory (default: $WEFT_HOME/substrate)")
  .option("--semantic-models-dir <dir>", "Path to semantic-models directory (default: $WEFT_HOME/models)")
  .option("--billing-project <project>", "GCP project for billing (defaults to BQ_PROJECT_ID env var)")
  .option("--accept-defaults", "Accept all recommended defaults without prompting")
  .action(async (opts: {
    name: string;
    purpose: string;
    substrateDir?: string;
    semanticModelsDir?: string;
    billingProject?: string;
    acceptDefaults?: boolean;
  }) => {
    const billingProject = opts.billingProject ?? process.env.BQ_PROJECT_ID;

    // Only require billing_project for BigQuery substrates
    const substrateDir = path.resolve(resolveSubstrateDir(opts.substrateDir));
    const connectorKind = await detectConnectorKind(substrateDir);
    if (connectorKind === "bigquery" && !billingProject) {
      console.error(
        "Error: --billing-project or BQ_PROJECT_ID must be set for BigQuery substrates.\n" +
          "The Malloy compiler needs it to resolve table schemas during validation.\n" +
          "Example: --billing-project my-project  or  export BQ_PROJECT_ID=my-project"
      );
      process.exit(1);
    }

    try {
      await runModelDesign({
        name: opts.name,
        purpose: opts.purpose,
        substrateDir: opts.substrateDir,
        semanticModelsDir: opts.semanticModelsDir,
        billingProject,
        acceptDefaults: opts.acceptDefaults,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("ANTHROPIC_API_KEY")) {
        console.error(`\n  ${message}`);
      } else {
        console.error(`\n  Error: ${message}\n`);
      }
      process.exit(1);
    }
  });

modelCmd
  .command("refine")
  .description("Refine a semantic model by adding or changing measures, dimensions, views, filters, or joins")
  .argument("<name>", "Name of the model to refine")
  .argument("<refinement>", "Natural-language change request (e.g. 'add a measure for total tool calls')")
  .option("--semantic-models-dir <dir>", "Path to semantic-models directory (default: $WEFT_HOME/models)")
  .option("--billing-project <project>", "GCP project for billing (defaults to BQ_PROJECT_ID env var)")
  .option("-y, --yes", "Apply without confirmation prompt")
  .action(async (name: string, refinement: string, opts: {
    semanticModelsDir?: string;
    billingProject?: string;
    yes?: boolean;
  }) => {
    const billingProject = opts.billingProject ?? process.env.BQ_PROJECT_ID;

    // Detect connector kind from the model's substrate — only BigQuery needs billing_project
    const semanticModelsDir = path.resolve(resolveSemanticModelsDir(opts.semanticModelsDir));
    const modelDir = path.join(semanticModelsDir, name);
    let modelConnectorKind: string | undefined;
    try {
      const manifestRaw = await fs.readFile(path.join(modelDir, "model.json"), "utf-8");
      const manifest = JSON.parse(manifestRaw);
      modelConnectorKind = manifest.connector_kind;
      if (!modelConnectorKind) {
        const substrateDir = path.resolve(modelDir, manifest.substrate_dir);
        modelConnectorKind = await detectConnectorKind(substrateDir);
      }
    } catch { /* will be caught by refineModel */ }

    if (modelConnectorKind === "bigquery" && !billingProject) {
      console.error(
        "Error: --billing-project or BQ_PROJECT_ID must be set for BigQuery models.\n" +
          "Example: --billing-project my-project  or  export BQ_PROJECT_ID=my-project"
      );
      process.exit(1);
    }

    try {
      await runModelRefine({
        name,
        refinement,
        semanticModelsDir: opts.semanticModelsDir,
        billingProject,
        yes: opts.yes,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("ANTHROPIC_API_KEY")) {
        console.error(`\n  ${message}`);
      } else {
        console.error(`\n  Error: ${message}\n`);
      }
      process.exit(1);
    }
  });

modelCmd
  .command("whatif")
  .description("Simulate a proposed change across the model's whole ask history (real recomputed impact)")
  .argument("<name>", "Name of the model to simulate against")
  .argument("<change>", "Proposed change in plain English (e.g. 'active_users should require at least 2 events')")
  .option("--semantic-models-dir <dir>", "Path to semantic-models directory (default: $WEFT_HOME/models)")
  .option("--billing-project <project>", "GCP project for billing (defaults to BQ_PROJECT_ID env var)")
  .option("--location <region>", "BigQuery dataset region (e.g. US, EU, asia-northeast1)", "US")
  .action(async (name: string, change: string, opts: {
    semanticModelsDir?: string;
    billingProject?: string;
    location: string;
  }) => {
    const billingProject = opts.billingProject ?? process.env.BQ_PROJECT_ID;

    // Only require billing_project for BigQuery models.
    const semanticModelsDir = path.resolve(resolveSemanticModelsDir(opts.semanticModelsDir));
    const modelDir = path.join(semanticModelsDir, name);
    let modelConnectorKind: string | undefined;
    try {
      const manifestRaw = await fs.readFile(path.join(modelDir, "model.json"), "utf-8");
      const manifest = JSON.parse(manifestRaw);
      modelConnectorKind = manifest.connector_kind;
      if (!modelConnectorKind) {
        const substrateDir = path.resolve(modelDir, manifest.substrate_dir);
        modelConnectorKind = await detectConnectorKind(substrateDir);
      }
    } catch { /* will be surfaced by simulateChange */ }

    if (modelConnectorKind === "bigquery" && !billingProject) {
      console.error(
        "Error: --billing-project or BQ_PROJECT_ID must be set for BigQuery models.\n" +
          "Example: --billing-project my-project  or  export BQ_PROJECT_ID=my-project"
      );
      process.exit(1);
    }

    try {
      await runModelWhatif({
        name,
        change,
        semanticModelsDir: opts.semanticModelsDir,
        billingProject,
        location: opts.location,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("ANTHROPIC_API_KEY")) {
        console.error(`\n  ${message}`);
      } else {
        console.error(`\n  Error: ${message}\n`);
      }
      process.exit(1);
    }
  });

modelCmd
  .command("revert")
  .description("Revert the last refinement to a semantic model (one level of undo)")
  .argument("<name>", "Name of the model to revert")
  .option("--semantic-models-dir <dir>", "Path to semantic-models directory (default: $WEFT_HOME/models)")
  .action(async (name: string, opts: { semanticModelsDir?: string }) => {
    try {
      await runModelRevert({ name, ...opts });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`\n  Error: ${message}\n`);
      process.exit(1);
    }
  });

// ── Context command ──────────────────────────────────────────
const contextCmd = program
  .command("context")
  .description("Inspect the decision-trace context graph");

contextCmd
  .command("graph")
  .description("Generate a self-contained interactive HTML view of a model's decision traces")
  .argument("<model>", "Name of the semantic model")
  .option("--semantic-models-dir <dir>", "Path to semantic-models directory (default: $WEFT_HOME/models)")
  .option("--out <file>", "Output HTML path (default: ./context-graph.html)")
  .action(async (model: string, opts: { semanticModelsDir?: string; out?: string }) => {
    try {
      await runContextGraph({
        model,
        semanticModelsDir: opts.semanticModelsDir,
        out: opts.out,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`\n  Error: ${message}\n`);
      process.exit(1);
    }
  });

program.parse();
