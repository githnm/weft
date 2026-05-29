/**
 * Build-failure triage for the model-design clarification loop.
 *
 * When a build reports failures (with real compiler errors), each is classified:
 *
 *   A) BUILD-INTERNAL — the build's own inconsistency (undefined joins/sources
 *      it referenced but never created, deprecated syntax, a decision it failed
 *      to carry through). The build fixes these itself by regenerating; the
 *      user is NOT asked. The user cannot answer "should opp_summary exist".
 *
 *   B) GENUINE AMBIGUITY — only the user can resolve (a metric with multiple
 *      valid definitions, a join path with data gaps, a user-given metric that
 *      is ambiguous against the schema). We generate a targeted question
 *      grounded in the ACTUAL failure and ask.
 *
 * Deterministic rules classify the clear build-internal cases; an LLM pass
 * classifies only the RESIDUAL failures and phrases grounded questions — it is
 * given the real diagnostics and forbidden from inventing problems.
 */

import { chat, stripCodeFences, type LLMUsage } from "../llm/anthropic.js";
import type { MeasureValidationResult } from "./compile.js";
import type { MeasureProbe } from "./probe.js";
import type { ResolvedDecision, ClarifyQuestion, ClarifyAnswer } from "./types.js";

export interface AutoFix {
  /** The measure/dimension/decision the fix concerns (for logging). */
  target: string;
  /** What the build should do, phrased for the regeneration prompt. */
  instruction: string;
}

export interface TriageResult {
  autoFixes: AutoFix[];
  questions: ClarifyQuestion[];
  usage: LLMUsage;
}

// Errors that are unambiguously the build's own inconsistency (type A).
const UNDEFINED_REF = /reference to undefined object|is not defined|is not a source or join|no such field|undefined field|cannot find/i;
const SYNTAX_BUG = /deprecated|count\(\s*distinct|cannot redefine|already defined|with primary_key|!=\s*null|=\s*null|<>\s*null|\|\||no viable alternative|extraneous input/i;
// Errors that are environmental (missing/unreadable table) — neither A nor B; the
// build can't fix them and the user can't answer them via clarification.
const ENV_ERROR = /unable to read schema|error fetching schema|does not exist in the substrate|permission denied/i;

function extractUndefinedName(error: string): string | null {
  const m =
    error.match(/undefined object '([^']+)'/i) ||
    error.match(/'([^']+)' is not defined/i) ||
    error.match(/'([^']+)' is not a source or join/i);
  return m ? m[1] : null;
}

const TRIAGE_PROMPT = `You are triaging Malloy model BUILD FAILURES. For each failure, decide who must fix it.

BUILD_INTERNAL — the build's own inconsistency that it can fix by regenerating:
- it referenced a join/source/field it never declared
- a syntax error
- it failed to carry a resolved decision into the model
The user cannot and should not answer these.

USER_DECISION — a genuine ambiguity only the user can resolve:
- a metric that has multiple valid definitions and the right one depends on intent (e.g. an engagement score as one computed measure vs per-action counts)
- a join path with data gaps where the user must choose include / exclude / treat separately
- a user-given metric that is ambiguous against the available schema

You are given the REAL failures (with the actual compiler errors), the current model, the decisions, and the table catalog. Classify ONLY these failures — do NOT invent problems. For USER_DECISION, write a specific question grounded in the actual failure, with 2-4 concrete options derived from the schema or the decision. Phrase options as choices a non-engineer can pick.

Return JSON only (no markdown fences):
{
  "failures": [
    {
      "name": "<measure/dimension/decision name>",
      "class": "build_internal" | "user_decision",
      "fix_instruction": "<if build_internal: what the build should do>",
      "question": "<if user_decision: the question>",
      "options": ["<option 1>", "<option 2>"],
      "grounded_in": "<the real error/expectation this is based on>"
    }
  ]
}`;

interface TriageInput {
  modelMalloy: string;
  failed: MeasureValidationResult[];
  unmetDecisions: { decision_id: string; chosen: string; expectation: string }[];
  decisions: ResolvedDecision[];
  tableCatalog: string;
  /**
   * Empty-measure probes whose emptiness is traced to a broken/low-coverage
   * join — genuine coherence conflicts (type B), grounded in real data.
   */
  dataConflicts?: MeasureProbe[];
}

/**
 * Turn a join-conflict data probe into a grounded type-B clarification. The
 * question is built ENTIRELY from the detected data (which join, which keys,
 * how many rows carry the key) — no speculation — with concrete options the
 * user can pick.
 */
function conflictToQuestion(probe: MeasureProbe): ClarifyQuestion | null {
  const jc = probe.joinConflict;
  if (!jc) return null;
  const missing = Math.max(0, jc.joinedTotal - jc.joinedWithKey);
  const grounded =
    `Measure "${probe.name}" returns ${probe.status === "zero" ? "0" : probe.status} for every row. ` +
    `It depends on join "${jc.alias}" (${jc.table}) via \`${jc.leftKey} = ${jc.alias}.${jc.rightKey}\`, ` +
    `but ${missing}/${jc.joinedTotal} rows in ${jc.table} have no ${jc.rightKey}, so they never attach.`;
  return {
    id: `conflict:${probe.name}`,
    question:
      `"${probe.name}" is empty because ${jc.table} rows can't attach to the chosen grain through ` +
      `\`${jc.leftKey} = ${jc.alias}.${jc.rightKey}\` (${missing} of ${jc.joinedTotal} ${jc.table} rows lack ${jc.rightKey}). ` +
      `How should ${jc.table} attach?`,
    options: [
      `Join ${jc.table} via a different key (choose a column that is populated and matches the grain)`,
      `Coalesce/derive the missing ${jc.rightKey} so anonymous rows still attach`,
      `Accept it: count only ${jc.table} rows that already have ${jc.rightKey} (the rest stay separate)`,
    ],
    grounded_in: grounded,
  };
}

/**
 * Triage build failures into auto-fixable (type A) and user-decision (type B).
 */
export async function triageBuildFailures(input: TriageInput): Promise<TriageResult> {
  const autoFixes: AutoFix[] = [];
  const questions: ClarifyQuestion[] = [];
  let usage: LLMUsage = { inputTokens: 0, outputTokens: 0 };

  // ── Data conflicts (empty measure ← broken join) are genuine type-B. ──
  // Grounded in the real probe; templated deterministically so they ALWAYS
  // surface (never lost to LLM variance) with concrete options.
  for (const probe of input.dataConflicts ?? []) {
    const q = conflictToQuestion(probe);
    if (q) questions.push(q);
  }

  // ── Unmet decisions are always build-internal: the build must carry them. ──
  for (const u of input.unmetDecisions) {
    autoFixes.push({
      target: u.decision_id,
      instruction: `The decision "${u.decision_id}" = "${u.chosen}" is not reflected in the model. ${u.expectation}.`,
    });
  }

  // ── Deterministic classification of failed measures/dimensions. ──
  const residual: MeasureValidationResult[] = [];
  for (const f of input.failed) {
    const err = f.error ?? "";
    if (UNDEFINED_REF.test(err)) {
      const undef = extractUndefinedName(err);
      autoFixes.push({
        target: f.name,
        instruction:
          `The ${f.kind} "${f.name}" references ${undef ? `\`${undef}\`, which is ` : "structure "}` +
          `not declared in the model. Either add the needed join/source/field (within the 3-join cap) ` +
          `or rewrite "${f.name}" against existing structure. Compiler error: ${err.split("\n")[0]}`,
      });
    } else if (SYNTAX_BUG.test(err)) {
      autoFixes.push({
        target: f.name,
        instruction: `The ${f.kind} "${f.name}" uses invalid/deprecated syntax. Fix it using the verified syntax reference. Compiler error: ${err.split("\n")[0]}`,
      });
    } else if (ENV_ERROR.test(err)) {
      // Environmental — surface as an auto-fix instruction (regeneration may pick
      // a different table), but it may remain unresolved and exit gracefully.
      autoFixes.push({
        target: f.name,
        instruction: `The ${f.kind} "${f.name}" hit a schema/connection error: ${err.split("\n")[0]}. If the table is wrong, use only tables present in the catalog.`,
      });
    } else {
      residual.push(f);
    }
  }

  // ── LLM pass ONLY for residual failures (possible genuine ambiguity). ──
  if (residual.length > 0) {
    try {
      const failuresText = residual
        .map((f) => `- ${f.kind} "${f.name}" (source ${f.owner}): ${f.expression}\n  ERROR: ${(f.error ?? "").split("\n").slice(0, 3).join(" ")}`)
        .join("\n");

      const response = await chat({
        system: TRIAGE_PROMPT,
        userParts: [
          `TABLE CATALOG:\n${input.tableCatalog}`,
          `CURRENT model.malloy:\n\`\`\`malloy\n${input.modelMalloy}\n\`\`\``,
          `RESOLVED DECISIONS:\n${input.decisions.map((d) => `- ${d.decision_id}: ${d.chosen}`).join("\n")}`,
          `BUILD FAILURES TO TRIAGE (classify ONLY these):\n${failuresText}`,
          `Return JSON only.`,
        ],
        maxTokens: 1200,
      });
      usage = response.usage;

      const parsed = JSON.parse(stripCodeFences(response.text)) as {
        failures?: Array<{
          name?: string;
          class?: string;
          fix_instruction?: string;
          question?: string;
          options?: string[];
          grounded_in?: string;
        }>;
      };

      for (const entry of parsed.failures ?? []) {
        const name = entry.name ?? "(unknown)";
        const source = residual.find((r) => r.name === name);
        const groundedIn = entry.grounded_in ?? source?.error?.split("\n")[0] ?? "";
        if (entry.class === "user_decision" && entry.question) {
          questions.push({
            id: name,
            question: entry.question,
            options: Array.isArray(entry.options) ? entry.options.filter((o) => typeof o === "string") : [],
            grounded_in: groundedIn,
          });
        } else {
          // Default residual → build_internal (the build attempts a fix).
          autoFixes.push({
            target: name,
            instruction:
              entry.fix_instruction ??
              `Fix the ${source?.kind ?? "item"} "${name}". Compiler error: ${source?.error?.split("\n")[0] ?? "(see diagnostics)"}`,
          });
        }
      }
    } catch {
      // LLM triage failed — fall back to treating residual as build-internal.
      for (const f of residual) {
        autoFixes.push({
          target: f.name,
          instruction: `Fix the ${f.kind} "${f.name}". Compiler error: ${(f.error ?? "").split("\n")[0]}`,
        });
      }
    }
  }

  return { autoFixes, questions, usage };
}

/**
 * Assemble corrective guidance for the regeneration prompt: the auto-fixes the
 * build must apply, the internal-consistency contract, and any authoritative
 * user clarifications.
 */
export function buildCorrectiveGuidance(autoFixes: AutoFix[], clarifications: ClarifyAnswer[]): string {
  const lines: string[] = [];
  if (autoFixes.length > 0) {
    lines.push("CORRECTIVE GUIDANCE — the previous build attempt had these problems. Fix ALL of them and regenerate the FULL model:");
    for (const f of autoFixes) lines.push(`- ${f.instruction}`);
    lines.push("");
  }
  lines.push(
    "CONSISTENCY CONTRACT: every join/source/field a measure references MUST be declared in the model. " +
      "If a measure needs a join that is not present, either add that join (within the 3-join cap) or rewrite the measure against existing structure. " +
      "Carry every resolved decision into the model (time anchors → a time dimension; conversion/ratio metrics → ratio measures with nullif zero-guards).",
  );
  if (clarifications.length > 0) {
    lines.push("");
    lines.push("USER CLARIFICATIONS (authoritative — implement exactly as the user decided):");
    for (const c of clarifications) lines.push(`- Q: ${c.question}\n  A: ${c.answer}`);
  }
  return lines.join("\n");
}
