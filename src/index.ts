import "dotenv/config";
import { loadConfigFromEnv, createBigQueryConnection } from "./connectors/bigquery.js";
import { createRuntime } from "./runtime/runtime.js";

const MALLOY_MODEL = `
  source: flights is bigquery.table('bigquery-public-data.austin_bikeshare.bikeshare_trips')
`;

const MALLOY_QUERY = `
source: trips is bigquery.table('bigquery-public-data.austin_bikeshare.bikeshare_trips') extend {
  measure: trip_count is count()
  measure: avg_duration is duration_minutes.avg()
}

run: trips -> {
  group_by: subscriber_type
  aggregate: 
    trip_count
    avg_duration
  order_by: trip_count desc
  limit: 5
}
`;

async function main(): Promise<void> {
  const config = loadConfigFromEnv();
  const connection = createBigQueryConnection(config);
  const runtime = createRuntime(connection);

  console.log("Connecting to BigQuery and running Malloy query...\n");

  const result = await runtime
    .loadModel(MALLOY_MODEL)
    .loadQuery(MALLOY_QUERY)
    .run();

  const rows = result.data.toObject();

  if (rows.length === 0) {
    console.log("Query returned no rows.");
    return;
  }

  console.log("Top 5 carriers by flight count:\n");
  console.table(rows);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);

  if (message.includes("Could not load the default credentials") || message.includes("PERMISSION_DENIED")) {
    console.error("BigQuery auth error:\n");
    console.error(message);
    console.error(
      "\nHint: make sure GOOGLE_APPLICATION_CREDENTIALS points to a valid service-account key,\n" +
        "or run `gcloud auth application-default login`.\n" +
        "Also verify BQ_PROJECT_ID is set to a project with BigQuery API enabled."
    );
  } else if (message.includes("malloy") || message.includes("parse") || message.includes("compile")) {
    console.error("Malloy compilation error:\n");
    console.error(message);
  } else {
    console.error("Unexpected error:\n");
    console.error(message);
  }

  process.exit(1);
});
