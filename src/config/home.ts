/**
 * Single source of truth for WHERE Weft keeps its local state.
 *
 * One root — WEFT_HOME — holds everything: connections, per-connection
 * substrates, and the semantic models. The MCP server, the web app, and the
 * CLI all resolve through here, so they always agree on the same place.
 *
 *   $WEFT_HOME/                      (default: <repo>/.weft)
 *   ├── connections.json             saved warehouse connections (secrets, 0600)
 *   ├── substrates/<conn-id>/        per-connection introspection output
 *   └── models/<name>/               built semantic models
 *
 * WHY cwd-independent: the MCP server runs as a subprocess of the IDE, whose
 * working directory is NOT the project. Resolving against `process.cwd()` (the
 * old behavior) made `./semantic-models` point somewhere random, which is why
 * users had to hardcode an absolute DEFAULT_MODELS_DIR. We instead resolve the
 * repo root from THIS compiled file's location, so the default just works no
 * matter where the process was launched from. Set WEFT_HOME to override.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Walk up from this module's location until we find the package.json root. */
function findRepoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url)); // dist/config (or src/config under tsx)
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd(); // last-resort fallback
}

let cached: string | undefined;

/**
 * The Weft home directory. Priority:
 *   WEFT_HOME (explicit) > WEFT_CONFIG_DIR (legacy alias) > <repo>/.weft
 * Resolved once and cached.
 */
export function weftHome(): string {
  if (cached) return cached;
  const explicit = process.env.WEFT_HOME || process.env.WEFT_CONFIG_DIR;
  cached = explicit ? path.resolve(explicit) : path.join(findRepoRoot(), ".weft");
  return cached;
}

/** Where built semantic models live: $WEFT_HOME/models/<name>. */
export function weftModelsDir(): string {
  return path.join(weftHome(), "models");
}

/** Default substrate (introspection output) dir: $WEFT_HOME/substrate. */
export function weftSubstrateDir(): string {
  return path.join(weftHome(), "substrate");
}

/** The repo root (absolute) — used by the MCP config generator. */
export function repoRoot(): string {
  return findRepoRoot();
}
