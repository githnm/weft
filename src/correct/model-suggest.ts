import fs from "node:fs/promises";
import path from "node:path";
import clipboard from "clipboardy";
import { chat, stripCodeFences } from "../llm/anthropic.js";
import { extractSourceSummary } from "../agent/catalog.js";
import { compileQuery } from "../agent/execute.js";
import type { ConnectorKind } from "../connectors/types.js";
import { addCorrection, generateCorrectionId } from "./store.js";
import { captureModelSuggestionTrace } from "../context/instrument.js";
import type { ModelSuggestionResult, CorrectionRecord } from "./types.js";
import type { Session } from "../session/types.js";

const SUGGEST_SYSTEM = `You are an analytics engineer suggesting a model edit to a Malloy source file based on a user's correction.

Given the current .malloy source and the correction, identify the specific line(s) to change and produce a replacement.

Return JSON (no markdown fences):
{
  "find_line": "<the existing line or block to locate in the file>",
  "replace_line": "<the replacement line or block>",
  "reasoning": "<one sentence explaining the change>"
}

Rules:
- The find_line must be an EXACT substring of the existing file.
- The replace_line must be valid Malloy syntax.
- Keep changes minimal — only modify what the correction requires.
- Preserve indentation and formatting.`;

/**
 * Generate a model edit suggestion that the user must apply manually.
 */
export async function prepareModelSuggestion(options: {
  correctionText: string;
  targetFile: string;
  modelsDir: string;
  billingProject?: string;
  session?: Session | null;
}): Promise<ModelSuggestionResult> {
  const { correctionText, targetFile, modelsDir, billingProject, session } = options;

  // Read the target .malloy file
  const filePath = path.join(modelsDir, targetFile);
  let sourceContent: string;
  try {
    sourceContent = await fs.readFile(filePath, "utf-8");
  } catch {
    throw new Error(`Target file "${targetFile}" not found in ${modelsDir}.`);
  }

  const summary = extractSourceSummary(targetFile, sourceContent);
  if (!summary) {
    throw new Error(`Could not parse a Malloy source from "${targetFile}".`);
  }

  // Provide session context if available
  const contextParts: string[] = [];
  if (session) {
    contextParts.push(
      `Previous query context:\n  Question: "${session.last_question}"\n  Malloy: ${session.last_malloy}`,
    );
  }

  // Ask LLM for the edit
  const response = await chat({
    system: SUGGEST_SYSTEM,
    userParts: [
      `Malloy source file (${targetFile}):\n\n${sourceContent}`,
      ...contextParts,
      `User correction: "${correctionText}"\n\nSuggest the minimal edit. Return JSON only.`,
    ],
    maxTokens: 1024,
  });

  const raw = stripCodeFences(response.text);
  let parsed: { find_line: string; replace_line: string; reasoning: string };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Failed to parse model suggestion response:\n${raw.slice(0, 300)}`);
  }

  if (!parsed.find_line || !parsed.replace_line) {
    throw new Error("Model suggestion missing find_line or replace_line.");
  }

  // Validate the edit compiles by splicing into a virtual copy
  const editedContent = sourceContent.replace(parsed.find_line, parsed.replace_line);
  if (editedContent === sourceContent) {
    throw new Error(
      `Could not locate the target line in ${targetFile}.\n` +
        `Expected to find: ${parsed.find_line.slice(0, 100)}`,
    );
  }

  // Read all .malloy files for compilation
  const entries = await fs.readdir(modelsDir);
  const malloyFiles = new Map<string, string>();
  for (const f of entries.filter((e) => e.endsWith(".malloy"))) {
    const content = await fs.readFile(path.join(modelsDir, f), "utf-8");
    malloyFiles.set(f, content);
  }
  // Override with edited version
  malloyFiles.set(targetFile, editedContent);

  // Detect connector kind for compile validation
  let connectorKind: ConnectorKind | undefined;
  try {
    const inspRaw = await fs.readFile(path.join(modelsDir, "inspection.json"), "utf-8");
    connectorKind = JSON.parse(inspRaw).connector_kind;
  } catch { /* default to bigquery */ }

  // Compile validation
  const testBlock = `run: ${summary.sourceName} -> {\n  aggregate: _validation_count is count()\n}`;
  let compileOk = true;

  const compileError = await compileQuery({
    sourceFilename: targetFile,
    runBlock: testBlock,
    modelsDir,
    malloyFiles,
    billingProject,
    connectorKind,
  });

  if (compileError) {
    // Retry once with the error
    const retryResponse = await chat({
      system: SUGGEST_SYSTEM,
      userParts: [
        `Malloy source file (${targetFile}):\n\n${sourceContent}`,
        `User correction: "${correctionText}"`,
        `Previous suggestion failed to compile:\n  find: ${parsed.find_line}\n  replace: ${parsed.replace_line}\n  Error: ${compileError}\n\nFix the suggestion. Return JSON only.`,
      ],
      maxTokens: 1024,
    });

    const retryRaw = stripCodeFences(retryResponse.text);
    try {
      const retryParsed = JSON.parse(retryRaw);
      parsed = retryParsed;
    } catch {
      compileOk = false;
    }

    if (compileOk) {
      const retryContent = sourceContent.replace(parsed.find_line, parsed.replace_line);
      malloyFiles.set(targetFile, retryContent);

      const retryError = await compileQuery({
        sourceFilename: targetFile,
        runBlock: testBlock,
        modelsDir,
        malloyFiles,
        billingProject,
        connectorKind,
      });

      if (retryError) {
        compileOk = false;
      }
    }
  }

  const correctionId = generateCorrectionId(targetFile.replace(".malloy", ""));

  return {
    targetFile,
    findLine: parsed.find_line,
    replaceLine: parsed.replace_line,
    compileOk,
    correctionId,
  };
}

/**
 * Log a model suggestion to corrections.json (no file edit applied).
 */
export async function logModelSuggestion(options: {
  result: ModelSuggestionResult;
  correctionText: string;
  modelsDir: string;
  session?: Session | null;
  /** The classification reasoning that prompted this suggestion (for the trace) */
  reasoning?: string;
}): Promise<void> {
  const { result, correctionText, modelsDir, session, reasoning } = options;

  const record: CorrectionRecord = {
    type: "model_suggestion",
    targetFile: result.targetFile,
    oldFilter: result.findLine,
    newFilter: result.replaceLine,
    userCorrectionText: correctionText,
    appliedAt: new Date().toISOString(),
    numericImpact: null,
    sessionQuestion: session?.last_question ?? "",
    description: correctionText.slice(0, 60),
  };

  await addCorrection(modelsDir, result.correctionId, record);

  // Capture a 'pending' correction trace linked to the asks that used the
  // affected entity. Never throws.
  await captureModelSuggestionTrace({
    modelsDir,
    correctionText,
    reasoning,
    targetFile: result.targetFile,
    findLine: result.findLine,
    replaceLine: result.replaceLine,
    correctionId: result.correctionId,
    compileOk: result.compileOk,
  });
}

/**
 * Copy text to the system clipboard. Returns true on success, false if unavailable.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await clipboard.write(text);
    return true;
  } catch {
    return false;
  }
}
