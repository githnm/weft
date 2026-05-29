# Weft

Ask your data in plain English. Weft interviews you to build a semantic model over your warehouse (BigQuery/Postgres via Malloy), then answers with verified queries and refuses to fabricate.

## Prerequisites

- Node.js 20+
- pnpm
- A Google Cloud project with BigQuery API enabled

## Install

```bash
pnpm install
```

## Authentication

**Option A — Application Default Credentials (easiest for local dev):**

```bash
gcloud auth application-default login
```

**Option B — Service account key:**

```bash
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
```

## Configuration

Copy the example env file and fill in your project ID:

```bash
cp .env.example .env
```

Edit `.env`:

```
BQ_PROJECT_ID=your-gcp-project-id
```

`BQ_PROJECT_ID` is required — BigQuery needs a billing project even when querying public datasets.

## Run

```bash
pnpm dev
```

Or build and run separately:

```bash
pnpm build
pnpm start
```

## Expected output

```
Connecting to BigQuery and running Malloy query...

Top 5 carriers by flight count:

┌─────────┬──────────┬──────────────┐
│ (index) │ carrier  │ flight_count │
├─────────┼──────────┼──────────────┤
│    0    │  'WN'    │    88751     │
│    1    │  'US'    │    37683     │
│    2    │  'AA'    │    34577     │
│    3    │  'NW'    │    33580     │
│    4    │  'UA'    │    32757     │
└─────────┴──────────┴──────────────┘
```

(Exact counts may differ depending on the dataset version.)
