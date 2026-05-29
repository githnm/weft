/**
 * Factory for creating warehouse connectors from configuration.
 *
 * Supports: bigquery, postgres
 */

import type { Connector, ConnectorConfig } from "./types.js";
import { BigQueryConnector } from "./bigquery-connector.js";
import { PostgresConnector } from "./postgres-connector.js";

export function createConnector(config: ConnectorConfig): Connector {
  switch (config.kind) {
    case "bigquery":
      return new BigQueryConnector(config);
    case "postgres":
      return new PostgresConnector(config);
    default:
      throw new Error(
        `Unknown connector kind: ${(config as { kind: string }).kind}`,
      );
  }
}
