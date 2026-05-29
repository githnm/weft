import fs from "node:fs/promises";
import path from "node:path";
import type { Session } from "./types.js";

const SESSION_FILENAME = "session.json";
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Load session.json from the models directory.
 * Returns null if the file doesn't exist, is corrupted, or is older than 30 minutes.
 * Silently deletes corrupted files.
 */
export async function loadSession(modelsDir: string): Promise<Session | null> {
  const filePath = path.join(modelsDir, SESSION_FILENAME);

  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch {
    return null; // file doesn't exist
  }

  let session: Session;
  try {
    session = JSON.parse(raw);
  } catch {
    // Corrupted — delete silently
    try {
      await fs.unlink(filePath);
    } catch {
      // ignore delete failure
    }
    console.log("  (session.json was corrupted; starting fresh)");
    return null;
  }

  // Validate required fields
  if (
    !session.last_question ||
    !session.last_source ||
    !session.last_malloy ||
    !session.last_at
  ) {
    try {
      await fs.unlink(filePath);
    } catch {
      // ignore
    }
    return null;
  }

  // Check TTL — session expires after 30 minutes
  const sessionTime = new Date(session.last_at).getTime();
  if (isNaN(sessionTime) || Date.now() - sessionTime > SESSION_TTL_MS) {
    return null; // expired
  }

  return session;
}

/**
 * Save session state after a successful query.
 * Overwrites any existing session.json.
 */
export async function saveSession(modelsDir: string, session: Session): Promise<void> {
  const filePath = path.join(modelsDir, SESSION_FILENAME);
  await fs.writeFile(filePath, JSON.stringify(session, null, 2), "utf-8");
}

/**
 * Delete session.json. No-op if the file doesn't exist.
 */
export async function clearSession(modelsDir: string): Promise<boolean> {
  const filePath = path.join(modelsDir, SESSION_FILENAME);
  try {
    await fs.unlink(filePath);
    return true;
  } catch {
    return false;
  }
}
