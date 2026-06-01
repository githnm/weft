import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { createConnector } from "../../connectors/factory.js";
import { inspectDataset } from "../../introspect/inspect.js";
import { classifyDataset } from "../../introspect/classify.js";
import { generateFiles } from "../../introspect/generate.js";
import { generateMetadata } from "../../introspect/metadata.js";
import { resolveBillingProject } from "../config.js";
import { resolveSubstrateDir } from "../../models/manifest.js";
import { text, formatBytes, formatCost } from "../format.js";
import { sendProgress } from "../progress.js";

export function register(server: McpServer): void {
  server.tool(
    "introspect_warehouse",
    "Introspect a warehouse dataset (BigQuery or Postgres). Generates Malloy models, captures metadata, and writes to the substrate directory. WARNING: Introspection is a heavy one-time operation best run via the CLI (`pnpm cli introspect`). Do NOT call this tool if a substrate already exists — first call list_substrate_tables to check. Only introspect if no substrate is found AND the user explicitly confirms they want to run a multi-minute operation. In an IDE, this tool has a 90-second timeout and will abort if it takes longer; use the CLI for large datasets.",
    {
      connector: z.enum(["bigquery", "postgres", "duckdb", "mysql", "snowflake"]).default("bigquery").describe("Connector type"),
      project: z.string().optional().describe("GCP project that owns the dataset (BigQuery only, e.g. 'bigquery-public-data')"),
      dataset: z.string().optional().describe("BigQuery dataset name (BigQuery only, e.g. 'austin_bikeshare')"),
      connection_string: z.string().optional().describe("Postgres/MySQL connection string. Postgres falls back to $POSTGRES_URL, MySQL to $MYSQL_URL."),
      pg_schema: z.string().default("public").describe("Postgres schema to introspect (Postgres only, default: 'public')"),
      file_path: z.string().optional().describe("DuckDB file path (DuckDB only) — a .duckdb file or a Parquet/CSV. Falls back to $DUCKDB_DATABASE. No server needed."),
      sf_account: z.string().optional().describe("Snowflake account identifier (org-account, e.g. 'myorg-myaccount')"),
      sf_user: z.string().optional().describe("Snowflake username"),
      sf_warehouse: z.string().optional().describe("Snowflake warehouse"),
      sf_database: z.string().optional().describe("Snowflake database"),
      sf_schema: z.string().default("PUBLIC").describe("Snowflake schema (default: PUBLIC)"),
      sf_role: z.string().optional().describe("Snowflake role (optional)"),
      sf_password: z.string().optional().describe("Snowflake password (or use sf_key for key-pair auth)"),
      sf_key: z.string().optional().describe("Snowflake private key file path (key-pair auth)"),
      models_dir: z.string().optional().describe("Output directory for models (default: ./substrate or $DEFAULT_SUBSTRATE_DIR). Previously called 'models', now defaults to substrate for the two-layer architecture."),
      billing_project: z.string().optional().describe("GCP billing project (BigQuery only, default: $BQ_PROJECT_ID)"),
      location: z.string().default("US").describe("BigQuery dataset region (e.g. US, EU, asia-northeast1)"),
      sample_rows: z.number().default(1000).describe("Number of sample rows per table"),
      exclude_enum: z.array(z.string()).optional().describe("Force-skip enum capture for these table.column pairs (e.g. ['bikeshare_stations.address'])"),
    },
    async (args) => {
      try {
        const outputDir = args.models_dir || resolveSubstrateDir();

        let connector;
        if (args.connector === "duckdb") {
          const filePath = args.file_path ?? process.env.DUCKDB_DATABASE;
          if (!filePath) {
            throw new McpError(
              ErrorCode.InvalidParams,
              "file_path is required for the DuckDB connector (a .duckdb file or a Parquet/CSV). Or set DUCKDB_DATABASE.",
            );
          }
          connector = createConnector({ kind: "duckdb", filePath });
        } else if (args.connector === "mysql") {
          const connectionString = args.connection_string ?? process.env.MYSQL_URL;
          if (!connectionString) {
            throw new McpError(ErrorCode.InvalidParams, "connection_string is required for MySQL (mysql://…). Or set MYSQL_URL.");
          }
          connector = createConnector({ kind: "mysql", connectionString });
        } else if (args.connector === "snowflake") {
          const account = args.sf_account ?? process.env.SNOWFLAKE_ACCOUNT;
          const username = args.sf_user ?? process.env.SNOWFLAKE_USER;
          const warehouse = args.sf_warehouse ?? process.env.SNOWFLAKE_WAREHOUSE;
          const database = args.sf_database ?? process.env.SNOWFLAKE_DATABASE;
          if (!account || !username || !warehouse || !database) {
            throw new McpError(ErrorCode.InvalidParams, "Snowflake requires sf_account, sf_user, sf_warehouse, sf_database (or the SNOWFLAKE_* env vars).");
          }
          connector = createConnector({
            kind: "snowflake",
            account, username, warehouse, database,
            schema: args.sf_schema,
            role: args.sf_role,
            password: args.sf_password ?? process.env.SNOWFLAKE_PASSWORD,
            privateKeyPath: args.sf_key ?? process.env.SNOWFLAKE_PRIVATE_KEY_PATH,
            privateKeyPassphrase: process.env.SNOWFLAKE_PRIVATE_KEY_PASSPHRASE,
          });
        } else if (args.connector === "postgres") {
          const connectionString = args.connection_string ?? process.env.POSTGRES_URL;
          if (!connectionString) {
            throw new McpError(
              ErrorCode.InvalidParams,
              "connection_string is required for the Postgres connector. Provide it as a tool input or set the POSTGRES_URL environment variable.",
            );
          }
          connector = createConnector({
            kind: "postgres",
            connectionString,
            schema: args.pg_schema,
          });
        } else {
          if (!args.project) {
            throw new McpError(ErrorCode.InvalidParams, "project is required for the BigQuery connector.");
          }
          if (!args.dataset) {
            throw new McpError(ErrorCode.InvalidParams, "dataset is required for the BigQuery connector.");
          }
          const billingProject = resolveBillingProject(args.billing_project);
          if (!billingProject) {
            throw new McpError(
              ErrorCode.InvalidParams,
              "billing_project is required for the BigQuery connector. Provide it as a tool input or set the BQ_PROJECT_ID environment variable.",
            );
          }
          connector = createConnector({
            kind: "bigquery",
            project: args.project,
            dataset: args.dataset,
            billingProject,
            location: args.location,
          });
        }

        // ── Hard timeout for IDE sessions ──
        // Introspection can take minutes on large datasets. In an IDE,
        // a hanging tool call breaks the session. Abort after 90s with
        // a clear message directing the user to the CLI.
        const INTROSPECT_TIMEOUT_MS = 90_000;
        let timedOut = false;
        const timeoutTimer = setTimeout(() => { timedOut = true; }, INTROSPECT_TIMEOUT_MS);

        const checkTimeout = () => {
          if (timedOut) {
            throw new McpError(
              ErrorCode.InternalError,
              "Introspection exceeded 90s timeout. This operation is too heavy for an IDE tool call.\n\n" +
              "Run via CLI instead:\n" +
              (args.connector === "postgres"
                ? "  pnpm cli introspect --connector postgres --connection-string $POSTGRES_URL --output ./substrate"
                : `  pnpm cli introspect --connector bigquery --project ${args.project ?? "<project>"} --dataset ${args.dataset ?? "<dataset>"} --output ./substrate`) +
              "\n\nThen use list_substrate_tables and propose_model_plan to work with the substrate.",
            );
          }
        };

        try {
          // ── Pass A: Inspection ──
          await sendProgress("Starting Pass A: inspecting tables...");

          const { inspection, metadataBytesScanned } = await inspectDataset(connector, {
            sampleRows: args.sample_rows,
            excludeEnums: args.exclude_enum,
          });

          checkTimeout();

          const jsonPath = path.join(outputDir, "inspection.json");
          await fs.mkdir(outputDir, { recursive: true });
          await fs.writeFile(jsonPath, JSON.stringify(inspection, null, 2), "utf-8");

          await sendProgress("Pass A complete. Starting Pass B: generating models...");

          // ── Pass B: Classification + Generation ──
          const classification = classifyDataset(inspection);
          await generateFiles(classification, inspection, outputDir);

          checkTimeout();

          await sendProgress("Pass B complete. Starting Pass C: generating metadata...");

          // ── Pass C: Metadata ──
          const metadataPath = path.join(outputDir, "metadata.json");
          generateMetadata(inspection, metadataPath);

          await sendProgress("All passes complete.");

          // Clean up connector resources
          await connector.close();

          // ── Format output ──
          const totalColumns = inspection.tables.reduce(
            (sum: number, t: { columns: unknown[] }) => sum + t.columns.length,
            0,
          );

          const summaryLines: string[] = [];
          summaryLines.push("## Introspection Complete\n");
          summaryLines.push(`**Connector:** ${args.connector}\n`);
          summaryLines.push("| Metric | Value |");
          summaryLines.push("| --- | ---: |");
          summaryLines.push(`| Tables inspected | ${inspection.tables.length} |`);
          summaryLines.push(`| Tables skipped | ${inspection.skipped_tables.length} |`);
          summaryLines.push(`| Columns inspected | ${totalColumns} |`);
          if (inspection.bytes_scanned > 0) {
            summaryLines.push(`| Bytes scanned | ${formatBytes(inspection.bytes_scanned)} |`);
            if (metadataBytesScanned > 0) {
              summaryLines.push(`| Metadata bytes | ${formatBytes(metadataBytesScanned)} |`);
            }
            const tbScanned = inspection.bytes_scanned / 1e12;
            const estimatedCost = tbScanned * 5;
            summaryLines.push(`| Estimated cost | ${formatCost(estimatedCost)} |`);
          }
          summaryLines.push(`| .malloy files | ${classification.tables.length} |`);
          summaryLines.push(`| Inferred joins | ${classification.inferred_joins.length} |`);
          if (inspection.foreign_keys && inspection.foreign_keys.length > 0) {
            summaryLines.push(`| Catalog FK constraints | ${inspection.foreign_keys.length} |`);
          }
          summaryLines.push("");
          summaryLines.push(`Output directory: \`${outputDir}\``);

          const content = [text(summaryLines.join("\n"))];

          // Warnings block
          if (inspection.warnings && inspection.warnings.length > 0) {
            const warningLines = [`## Warnings (${inspection.warnings.length})\n`];
            for (const w of inspection.warnings) {
              warningLines.push(`- ${w}`);
            }
            content.push(text(warningLines.join("\n")));
          }

          // Skipped tables block
          if (inspection.skipped_tables.length > 0) {
            const skippedLines = [`## Skipped Tables\n`];
            skippedLines.push("| Table | Reason |");
            skippedLines.push("| --- | --- |");
            for (const s of inspection.skipped_tables) {
              skippedLines.push(`| ${s.name} | ${s.reason} |`);
            }
            content.push(text(skippedLines.join("\n")));
          }

          return { content };
        } finally {
          clearTimeout(timeoutTimer);
        }
      } catch (err: unknown) {
        if (err instanceof McpError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[introspect_warehouse] ${message}`);

        if (message.includes("Could not load the default credentials") || message.includes("PERMISSION_DENIED")) {
          throw new McpError(
            ErrorCode.InternalError,
            `BigQuery auth error: ${message}\n\nSet GOOGLE_APPLICATION_CREDENTIALS or run \`gcloud auth application-default login\`.`,
          );
        }
        if (message.includes("Not found: Dataset")) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `Dataset not found: ${message}\n\nCheck the project and dataset names.`,
          );
        }
        if (message.includes("ECONNREFUSED") || message.includes("ETIMEDOUT") || message.includes("ENOTFOUND")) {
          throw new McpError(
            ErrorCode.InternalError,
            `Postgres connection error: ${message}\n\nCheck the connection string, hostname, port, and that the database is reachable.`,
          );
        }
        if (message.includes("statement timeout") || message.includes("canceling statement due to statement timeout")) {
          throw new McpError(
            ErrorCode.InternalError,
            `Postgres query timed out during introspection: ${message}\n\n` +
            "The database's statement_timeout may be too low for introspection queries. " +
            "This can happen on free-tier cloud Postgres (Supabase, Neon). " +
            "Try excluding large tables with exclude_enum or reducing sample_rows.",
          );
        }
        if (message.includes("password authentication failed") || message.includes("no pg_hba.conf entry")) {
          throw new McpError(
            ErrorCode.InternalError,
            `Postgres auth error: ${message}\n\nCheck the username and password.`,
          );
        }
        if (message.includes("SSL") || message.includes("self-signed certificate") || message.includes("self signed certificate")) {
          throw new McpError(
            ErrorCode.InternalError,
            `Postgres SSL error: ${message}\n\nAdd ?sslmode=require to the connection string for cloud Postgres.`,
          );
        }
        throw new McpError(ErrorCode.InternalError, message);
      }
    },
  );
}
