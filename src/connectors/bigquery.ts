import { BigQueryConnection } from "@malloydata/db-bigquery";

export interface BigQueryConfig {
  projectId: string;
  serviceAccountKeyPath?: string;
  /**
   * BigQuery dataset region. Defaults to "US".
   * Must match the region of the dataset being queried.
   * Common values: US, EU, asia-northeast1, asia-south1,
   * australia-southeast1, europe-west1.
   */
  location?: string;
}

export function createBigQueryConnection(config: BigQueryConfig): BigQueryConnection {
  return new BigQueryConnection({
    name: "bigquery",
    projectId: config.projectId,
    serviceAccountKeyPath: config.serviceAccountKeyPath,
    location: config.location ?? "US",
  });
}

export function loadConfigFromEnv(): BigQueryConfig {
  const projectId = process.env.BQ_PROJECT_ID;
  if (!projectId) {
    throw new Error(
      "BQ_PROJECT_ID is not set.\n" +
        "Set it to the GCP project ID that should be billed for BigQuery queries.\n" +
        "Example: export BQ_PROJECT_ID=my-gcp-project"
    );
  }

  const serviceAccountKeyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || undefined;

  if (!serviceAccountKeyPath) {
    console.warn(
      "GOOGLE_APPLICATION_CREDENTIALS is not set — using Application Default Credentials.\n" +
        "Run `gcloud auth application-default login` if you haven't already."
    );
  }

  return { projectId, serviceAccountKeyPath };
}
