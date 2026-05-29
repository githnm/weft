import { loadSession, clearSession } from "../../session/store.js";

export async function runSessionShow(options: { modelsDir: string }): Promise<void> {
  const session = await loadSession(options.modelsDir);

  if (!session) {
    console.log("\n  No active session.\n");
    return;
  }

  console.log("\n  Session state:");
  console.log(`    Last question:  ${session.last_question}`);
  console.log(`    Source:         ${session.last_source}`);
  console.log(`    Timestamp:      ${session.last_at}`);

  const age = Math.round((Date.now() - new Date(session.last_at).getTime()) / 60000);
  console.log(`    Age:            ${age} minute${age !== 1 ? "s" : ""}`);
  console.log("");

  if (session.last_filters.length > 0) {
    console.log("    Filters:");
    for (const f of session.last_filters) {
      const termNote = f.applied_term ? ` (term: ${f.applied_term})` : "";
      console.log(`      - ${f.expression}${termNote}`);
    }
  } else {
    console.log("    Filters:        (none)");
  }

  if (session.last_group_by.length > 0) {
    console.log(`    Group by:       ${session.last_group_by.join(", ")}`);
  } else {
    console.log("    Group by:       (none)");
  }

  if (session.last_aggregates.length > 0) {
    console.log(`    Aggregates:     ${session.last_aggregates.join(", ")}`);
  } else {
    console.log("    Aggregates:     (none)");
  }

  if (session.last_time_range) {
    console.log(`    Time range:     ${session.last_time_range.column} [${session.last_time_range.start} .. ${session.last_time_range.end}]`);
  } else {
    console.log("    Time range:     (none)");
  }

  if (session.last_result_summary) {
    console.log(`    Last result:    ${session.last_result_summary.row_count} rows`);
  }

  console.log("");
  console.log("    Malloy:");
  for (const line of session.last_malloy.split("\n")) {
    console.log(`      ${line}`);
  }
  console.log("");
}

export async function runSessionClear(options: { modelsDir: string }): Promise<void> {
  const deleted = await clearSession(options.modelsDir);
  if (deleted) {
    console.log("\n  Session cleared.\n");
  } else {
    console.log("\n  No session to clear.\n");
  }
}
