import fs from "node:fs/promises";
import path from "node:path";
import { extractSourceSummary } from "./catalog.js";
import { selectSource } from "./select.js";
import { checkFeasibility } from "./feasibility.js";
import { generateQuery, retryQuery } from "./generate.js";
import { executeQuery } from "./execute.js";
import { verifyResult } from "./verify.js";
import { loadMetadata, getSourceMetadata } from "./metadata-loader.js";
import { loadTerms, filterTermsForSource, incrementTermUsage } from "../terms/store.js";
import { proposeTermsFromMatches } from "../terms/propose.js";
import { loadSession, saveSession } from "../session/store.js";
import { classifyFollowUp } from "../session/follow-up.js";
import { extractFilters, extractGroupBy, extractAggregates, extractTimeRange } from "../session/parse-malloy.js";
import { looksLikeCorrection, classifyCorrection } from "../correct/classify.js";
import { captureAskOutcome } from "../context/instrument.js";
import { loadConcepts, buildConceptsPrompt } from "../interview/definitions.js";
import type { ConnectorKind } from "../connectors/types.js";
import type { AskResult, SourceSummary, LLMUsage, FollowUpResult } from "./types.js";
import type { Session, SessionContext } from "../session/types.js";
import type { ClassifyResult } from "../correct/types.js";

export type { AskResult } from "./types.js";

/**
 * Structured error for query failures. The CLI layer uses this to
 * print a clean message instead of a stack trace.
 */
export class QueryError extends Error {
  constructor(
    message: string,
    public readonly malloy: string,
    public readonly phase: "compile" | "execute",
  ) {
    super(message);
    this.name = "QueryError";
  }
}

export interface AskOptions {
  question: string;
  modelsDir: string;
  /** GCP billing project — required for BigQuery, ignored for Postgres. */
  billingProject?: string;
  /** BigQuery region (default "US"). Must match the dataset's region. */
  location?: string;
  /** Skip source selection; use this source filename directly */
  sourceOverride?: string;
  /** Print generated Malloy to console */
  showMalloy?: boolean;
  /** Compile-only, don't execute against BigQuery */
  dryRun?: boolean;
  /** Skip the feasibility check */
  skipFeasibility?: boolean;
  /** Skip both verification layers */
  noVerify?: boolean;
  /** Skip layer 2 (LLM semantic check) only */
  noLlmVerify?: boolean;
  /** Clear session before running (treat as fresh question) */
  newSession?: boolean;
  /** Ignore session entirely (don't load, don't update) */
  noSession?: boolean;
  /**
   * Optional progress callback — fires at each pipeline stage as it happens.
   * Used by streaming UIs (the web API's SSE). CLI/MCP omit it.
   */
  onStage?: (event: AskStageEvent) => void;
}

export interface AskStageEvent {
  stage: "source_selected" | "feasibility" | "generating" | "executing" | "verifying";
  detail?: Record<string, unknown>;
}

function addUsage(a: LLMUsage, b: LLMUsage): LLMUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
}

/**
 * Scope loaded terms to the selected source.
 *
 * A semantic model is self-contained: its `model.malloy` is the single
 * queryable source and its terms.json holds only that model's terms. So every
 * term applies when querying the model, regardless of which base-table file it
 * happened to be tagged to at define time. Substrate sources (one file per
 * table, sharing a terms.json) stay scoped per source filename.
 */
function scopeTermsForSource(
  allTerms: Awaited<ReturnType<typeof loadTerms>>,
  sourceFilename: string,
): Awaited<ReturnType<typeof loadTerms>> {
  if (sourceFilename === "model.malloy") return allTerms;
  return filterTermsForSource(allTerms, sourceFilename);
}

export async function ask(options: AskOptions): Promise<AskResult> {
  const { question, modelsDir, billingProject, sourceOverride, dryRun } = options;

  // ── Validate input ──────────────────────────────────────────
  if (!question.trim()) {
    throw new Error("Question cannot be empty.");
  }

  // ── Read all .malloy files ────────────────────────────────────
  const entries = await fs.readdir(modelsDir);
  const malloyFileNames = entries.filter((f) => f.endsWith(".malloy")).sort();

  if (malloyFileNames.length === 0) {
    throw new Error(
      `No .malloy files found in ${modelsDir}\n` +
        "Run 'pnpm cli introspect' first to generate models.",
    );
  }

  const malloyFiles = new Map<string, string>();
  for (const name of malloyFileNames) {
    const content = await fs.readFile(path.join(modelsDir, name), "utf-8");
    malloyFiles.set(name, content);
  }

  // ── Detect connector kind from inspection.json ────────────────
  let connectorKind: ConnectorKind | undefined;
  try {
    const inspectionPath = path.join(modelsDir, "inspection.json");
    const inspectionRaw = await fs.readFile(inspectionPath, "utf-8");
    const inspection = JSON.parse(inspectionRaw);
    connectorKind = inspection.connector_kind;
  } catch {
    // inspection.json may not exist (e.g. hand-authored models) — default to bigquery
  }

  // ── Build catalog ─────────────────────────────────────────────
  const summaries: SourceSummary[] = [];
  for (const [filename, content] of malloyFiles) {
    const summary = extractSourceSummary(filename, content);
    if (summary) summaries.push(summary);
  }

  if (summaries.length === 0) {
    throw new Error("No valid Malloy sources found in model files.");
  }

  let totalUsage: LLMUsage = { inputTokens: 0, outputTokens: 0 };

  // ── STAGE 0.5: Session / follow-up classification ──────────────
  let session: Session | null = null;
  let followUp: FollowUpResult | undefined;
  let sessionContext: SessionContext | undefined;
  let previousQuestion: string | undefined;

  if (!options.noSession) {
    if (options.newSession) {
      // Clear before loading — forces fresh question
      const { clearSession: clear } = await import("../session/store.js");
      await clear(modelsDir);
    }

    session = await loadSession(modelsDir);

    if (session) {
      previousQuestion = session.last_question;

      followUp = await classifyFollowUp(question, session);
      totalUsage = addUsage(totalUsage, followUp.usage);

      if (followUp.isFollowUp) {
        sessionContext = {
          lastQuestion: session.last_question,
          lastSource: session.last_source,
          lastMalloy: session.last_malloy,
          lastFilters: session.last_filters,
          lastGroupBy: session.last_group_by,
          lastAggregates: session.last_aggregates,
          lastTimeRange: session.last_time_range,
          inherit: followUp.inherit,
        };
      }
    }
  }

  // ── STAGE 0.75: Inline correction detection ─────────────────
  // Fast regex pre-filter + LLM classification.
  // Only triggers when session exists (there's a prior query to correct).
  if (!options.noSession && session && looksLikeCorrection(question)) {
    try {
      const classification = await classifyCorrection(question, modelsDir, session);
      totalUsage = addUsage(totalUsage, classification.usage);

      // Only branch to correction flow if confidence is high or medium
      if (
        classification.confidence !== "low" &&
        classification.type !== "unclear"
      ) {
        return {
          question,
          source: {
            filename: session.last_source,
            sourceName: session.last_source.replace(".malloy", ""),
            reasoning: "Correction detected — using session source",
            usage: { inputTokens: 0, outputTokens: 0 },
          },
          previousQuestion: session.last_question,
          correctionDetected: classification,
          totalUsage,
        };
      }
      // Low confidence / unclear: fall through to normal ask flow
    } catch {
      // Classification failed — proceed with normal flow
    }
  }

  // ── STAGE 1: Source selection ─────────────────────────────────
  let sourceSelection;
  let sourceInherited = false;

  if (sourceOverride) {
    // Explicit --source always wins
    const match = summaries.find(
      (s) =>
        s.filename === sourceOverride ||
        s.sourceName === sourceOverride ||
        s.filename === `${sourceOverride}.malloy`,
    );
    if (!match) {
      throw new Error(
        `Source "${sourceOverride}" not found.\nAvailable: ${summaries.map((s) => `${s.sourceName} (${s.filename})`).join(", ")}`,
      );
    }
    sourceSelection = {
      filename: match.filename,
      sourceName: match.sourceName,
      reasoning: "User specified --source",
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  } else if (sessionContext && sessionContext.inherit.source) {
    // Inherit source from session
    const match = summaries.find((s) => s.filename === sessionContext!.lastSource);
    if (match) {
      sourceSelection = {
        filename: match.filename,
        sourceName: match.sourceName,
        reasoning: "Inherited from previous question",
        usage: { inputTokens: 0, outputTokens: 0 },
      };
      sourceInherited = true;
    } else {
      // Last source no longer exists — fall back to selection
      sourceSelection = await selectSource(question, summaries);
      totalUsage = addUsage(totalUsage, sourceSelection.usage);
    }
  } else {
    sourceSelection = await selectSource(question, summaries);
    totalUsage = addUsage(totalUsage, sourceSelection.usage);
  }

  options.onStage?.({
    stage: "source_selected",
    detail: { source: sourceSelection.sourceName, filename: sourceSelection.filename, reasoning: sourceSelection.reasoning },
  });

  // ── Resolve source content + imports ───────────────────────────
  const sourceContent = malloyFiles.get(sourceSelection.filename)!;

  const importedFiles = new Map<string, string>();
  for (const m of sourceContent.matchAll(/^\s*import\s+"([^"]+)"/gm)) {
    const importName = m[1];
    const importContent = malloyFiles.get(importName);
    if (importContent) {
      importedFiles.set(importName, importContent);
    }
  }

  // ── Load metadata (optional) ──────────────────────────────────
  const metadata = await loadMetadata(modelsDir);
  const sourceMetadata = metadata
    ? getSourceMetadata(metadata, sourceSelection.sourceName)
    : null;

  // ── Load terms (optional) ────────────────────────────────────
  const allTerms = await loadTerms(modelsDir);
  const sourceTerms = scopeTermsForSource(allTerms, sourceSelection.filename);

  // ── Load baked concepts + their explicit aliases (model metadata) ──
  // Injected into feasibility + generate so any confirmed alias applies the
  // concept's filter. Empty string when the model has no concepts.
  const conceptsPrompt = buildConceptsPrompt(await loadConcepts(modelsDir));

  // ── STAGE 1.5: Feasibility check ─────────────────────────────
  let feasibility: Awaited<ReturnType<typeof checkFeasibility>> | undefined;

  if (!options.skipFeasibility) {
    feasibility = await checkFeasibility({
      question,
      sourceContent,
      sourceName: sourceSelection.sourceName,
      importedFiles: importedFiles.size > 0 ? importedFiles : undefined,
      sourceMetadata: sourceMetadata ?? undefined,
      sourceTerms: Object.keys(sourceTerms).length > 0 ? sourceTerms : undefined,
      concepts: conceptsPrompt || undefined,
      sessionContext,
    });
    totalUsage = addUsage(totalUsage, feasibility.usage);
    options.onStage?.({ stage: "feasibility", detail: { feasible: feasibility.feasible } });

    if (!feasibility.feasible) {
      // If inherited source can't answer the question, retry with fresh selection
      if (sourceInherited) {
        console.log("  Follow-up source could not answer the new question; selecting a fresh source.");
        sourceSelection = await selectSource(question, summaries);
        totalUsage = addUsage(totalUsage, sourceSelection.usage);
        sourceInherited = false;
        // Invalidate session context — source changed
        sessionContext = undefined;

        // Re-resolve content for the new source
        const newContent = malloyFiles.get(sourceSelection.filename)!;
        const newImports = new Map<string, string>();
        for (const m of newContent.matchAll(/^\s*import\s+"([^"]+)"/gm)) {
          const importName = m[1];
          const ic = malloyFiles.get(importName);
          if (ic) newImports.set(importName, ic);
        }

        const newMeta = metadata ? getSourceMetadata(metadata, sourceSelection.sourceName) : null;
        const newTerms = scopeTermsForSource(allTerms, sourceSelection.filename);

        feasibility = await checkFeasibility({
          question,
          sourceContent: newContent,
          sourceName: sourceSelection.sourceName,
          importedFiles: newImports.size > 0 ? newImports : undefined,
          sourceMetadata: newMeta ?? undefined,
          sourceTerms: Object.keys(newTerms).length > 0 ? newTerms : undefined,
          concepts: conceptsPrompt || undefined,
        });
        totalUsage = addUsage(totalUsage, feasibility.usage);

        if (!feasibility.feasible) {
          return captureAskOutcome(modelsDir, {
            question,
            source: sourceSelection,
            followUp,
            feasibility,
            previousQuestion,
            totalUsage,
          });
        }
      } else {
        return captureAskOutcome(modelsDir, {
          question,
          source: sourceSelection,
          followUp,
          feasibility,
          previousQuestion,
          totalUsage,
        });
      }
    }
  }

  // ── Resolve final source content (may have changed after fallback) ──
  const finalSourceContent = malloyFiles.get(sourceSelection.filename)!;
  const finalImports = new Map<string, string>();
  for (const m of finalSourceContent.matchAll(/^\s*import\s+"([^"]+)"/gm)) {
    const importName = m[1];
    const ic = malloyFiles.get(importName);
    if (ic) finalImports.set(importName, ic);
  }
  const finalMeta = metadata ? getSourceMetadata(metadata, sourceSelection.sourceName) : null;

  // ── STAGE 2: Query generation ─────────────────────────────────
  options.onStage?.({ stage: "generating" });
  let query = await generateQuery({
    question,
    sourceName: sourceSelection.sourceName,
    sourceContent: finalSourceContent,
    importedFiles: finalImports.size > 0 ? finalImports : undefined,
    sourceMetadata: finalMeta ?? undefined,
    matchedEnumValues: feasibility?.matchedEnumValues,
    matchedTerms: feasibility?.matchedTerms,
    concepts: conceptsPrompt || undefined,
    sessionContext,
  });
  totalUsage = addUsage(totalUsage, query.usage);

  // ── STAGE 2.5: Structural pre-check of the generated query ────
  // Compile the generated query in ISOLATION before executing. This catches
  // malformed query structure (e.g. `nest:` outside the block, a bad ratio,
  // wrong time-grouping) regardless of which construct is wrong — analogous to
  // per-measure validation in the build. On a compile failure, feed the REAL
  // compiler error back to the generator for ONE teaching-retry.
  if (!dryRun) {
    const precheck = await executeQuery({
      sourceFilename: sourceSelection.filename,
      runBlock: query.malloy,
      modelsDir,
      malloyFiles,
      billingProject,
      location: options.location,
      dryRun: true,
      connectorKind,
    });
    if (!precheck.ok && precheck.phase === "compile") {
      console.log("  ⚠ Generated query failed structural compile. Teaching-retry with the compiler error...");
      const fixed = await retryQuery({
        question,
        sourceName: sourceSelection.sourceName,
        sourceContent: finalSourceContent,
        failedMalloy: query.malloy,
        error: precheck.error,
        errorPhase: "compile",
      });
      totalUsage = addUsage(totalUsage, fixed.usage);
      query = fixed;
    }
  }

  // ── STAGE 3: Execute (with unified retry) ─────────────────────
  //
  // One retry attempt covers BOTH compile and BQ execution errors.
  // executeQuery() returns { ok, result } or { ok: false, error, phase }.
  let execution;

  const execOpts = {
    sourceFilename: sourceSelection.filename,
    runBlock: query.malloy,
    modelsDir,
    malloyFiles,
    billingProject,
    location: options.location,
    dryRun,
    connectorKind,
  };

  options.onStage?.({ stage: "executing" });
  const firstAttempt = await executeQuery(execOpts);

  if (!firstAttempt.ok) {
    const label = firstAttempt.phase === "compile" ? "compile" : "execute against BigQuery";
    console.log(`\n  ⚠ First attempt failed to ${label}. Retrying...`);

    const retried = await retryQuery({
      question,
      sourceName: sourceSelection.sourceName,
      sourceContent: finalSourceContent,
      failedMalloy: query.malloy,
      error: firstAttempt.error,
      errorPhase: firstAttempt.phase,
    });
    totalUsage = addUsage(totalUsage, retried.usage);

    const secondAttempt = await executeQuery({
      ...execOpts,
      runBlock: retried.malloy,
    });

    if (!secondAttempt.ok) {
      throw new QueryError(
        `Query failed to ${secondAttempt.phase === "compile" ? "compile" : "execute"} after retry.\n\n` +
          `Error:\n${secondAttempt.error}`,
        retried.malloy,
        secondAttempt.phase,
      );
    }

    query = retried;
    if (!dryRun) execution = secondAttempt.result;
  } else if (!dryRun) {
    execution = firstAttempt.result;
  }

  // ── STAGE 4: Verify ──────────────────────────────────────────
  let verification;

  if (execution && !options.noVerify) {
    options.onStage?.({ stage: "verifying" });
    verification = await verifyResult({
      question,
      malloy: query.malloy,
      rows: execution.rows,
      totalRows: execution.totalRows,
      skipLlmVerify: options.noLlmVerify,
    });
    totalUsage = addUsage(totalUsage, verification.usage);
  }

  // ── Post-execution: term usage tracking + auto-propose ────────
  let proposedTerms: { key: string; userTerm: string; filter: string }[] | undefined;

  if (execution) {
    // Increment usage counters for matched terms (best-effort — don't fail the query)
    if (feasibility?.matchedTerms && feasibility.matchedTerms.length > 0) {
      try {
        const termKeys = feasibility.matchedTerms.map((t) => t.name);
        await incrementTermUsage(modelsDir, termKeys);
      } catch {
        // Silently ignore — usage tracking is non-critical
      }
    }

    // Auto-propose terms from enum matches (best-effort)
    if (feasibility?.matchedEnumValues && feasibility.matchedEnumValues.length > 0) {
      try {
        const proposals = await proposeTermsFromMatches({
          modelsDir,
          sourceFilename: sourceSelection.filename,
          question,
          matchedEnumValues: feasibility.matchedEnumValues,
        });
        if (proposals.length > 0) {
          proposedTerms = proposals;
        }
      } catch {
        // Silently ignore — proposal is non-critical
      }
    }
  }

  // ── Post-execution: update session ──────────────────────────
  if (!options.noSession && query && (execution || dryRun)) {
    try {
      const malloyText = query.malloy;

      // Parse structured info from generated Malloy (best-effort)
      const parsedFilters = extractFilters(malloyText);
      const parsedGroupBy = extractGroupBy(malloyText);
      const parsedAggregates = extractAggregates(malloyText);
      const parsedTimeRange = extractTimeRange(malloyText);

      // Annotate filters with matched terms
      const sessionFilters = parsedFilters.map((f) => {
        const matchedTerm = feasibility?.matchedTerms?.find(
          (t) => f.expression.includes(t.filter) || t.filter.includes(f.expression),
        );
        return matchedTerm
          ? { expression: f.expression, applied_term: matchedTerm.name }
          : f;
      });

      const newSession: Session = {
        last_question: question,
        last_source: sourceSelection.filename,
        last_malloy: malloyText,
        last_filters: sessionFilters,
        last_group_by: parsedGroupBy,
        last_aggregates: parsedAggregates,
        last_time_range: parsedTimeRange,
        last_result_summary: {
          row_count: execution?.totalRows ?? 0,
          first_row: execution?.rows?.[0] ?? null,
        },
        last_at: new Date().toISOString(),
      };

      await saveSession(modelsDir, newSession);
    } catch {
      // Session save is non-critical
    }
  }

  return captureAskOutcome(modelsDir, {
    question,
    source: sourceSelection,
    followUp,
    feasibility,
    query,
    execution,
    verification,
    proposedTerms,
    previousQuestion,
    totalUsage,
  });
}
