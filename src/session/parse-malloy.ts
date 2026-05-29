import type { SessionFilter, SessionTimeRange } from "./types.js";

/**
 * Extract structured information from a generated Malloy `run:` block.
 *
 * This is best-effort regex parsing — not a full Malloy parser.
 * If parsing fails for a section, that section returns empty/null.
 * The LLM can still reason about the raw malloy string on follow-ups.
 */

/**
 * Extract where: filter expressions from the run block.
 *
 * Handles patterns like:
 *   where: subscriber_type = 'Student Membership' | 'U.T. Student Membership'
 *   where: status = 'active'
 *   where: start_time > @2014-01-01 and start_time < @2014-04-01
 *
 * Also handles multi-line where blocks.
 */
export function extractFilters(malloy: string): SessionFilter[] {
  const filters: SessionFilter[] = [];

  // Match where: lines — capture everything after "where:" until the next keyword or closing brace
  const whereRegex = /where:\s*(.+?)(?=\n\s*(?:group_by|aggregate|order_by|limit|nest|where|index|calculate|top|having|\})|$)/gs;

  let match: RegExpExecArray | null;
  while ((match = whereRegex.exec(malloy)) !== null) {
    const filterBlock = match[1].trim();
    if (filterBlock) {
      // Split on " and " to separate compound filters, but keep the full expression too
      // For now, store as a single expression — compound splitting is fragile
      filters.push({ expression: filterBlock });
    }
  }

  return filters;
}

/**
 * Extract group_by field names from the run block.
 *
 * Handles:
 *   group_by: subscriber_type
 *   group_by: start_time.month, subscriber_type
 *   group_by:\n    subscriber_type\n    start_time.month
 */
export function extractGroupBy(malloy: string): string[] {
  const fields: string[] = [];

  // Match group_by: blocks — inline or multi-line
  const gbRegex = /group_by:\s*([\s\S]*?)(?=\n\s*(?:aggregate|order_by|limit|nest|where|index|calculate|top|having|\})|$)/g;

  let match: RegExpExecArray | null;
  while ((match = gbRegex.exec(malloy)) !== null) {
    const block = match[1].trim();
    if (!block) continue;

    // Split by commas or newlines
    const items = block.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
    for (const item of items) {
      // Extract the field name — strip "is ..." definitions
      const nameMatch = item.match(/^(\w[\w.]*)/);
      if (nameMatch) {
        fields.push(nameMatch[1]);
      }
    }
  }

  return fields;
}

/**
 * Extract aggregate field names from the run block.
 *
 * Handles:
 *   aggregate: row_count
 *   aggregate: row_count, avg_duration
 *   aggregate:\n    row_count\n    avg_duration is duration_minutes.avg()
 */
export function extractAggregates(malloy: string): string[] {
  const fields: string[] = [];

  const aggRegex = /aggregate:\s*([\s\S]*?)(?=\n\s*(?:group_by|order_by|limit|nest|where|index|calculate|top|having|\})|$)/g;

  let match: RegExpExecArray | null;
  while ((match = aggRegex.exec(malloy)) !== null) {
    const block = match[1].trim();
    if (!block) continue;

    const items = block.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
    for (const item of items) {
      // Extract the field name (before " is " if present)
      const nameMatch = item.match(/^(\w[\w.]*)/);
      if (nameMatch) {
        fields.push(nameMatch[1]);
      }
    }
  }

  return fields;
}

/**
 * Extract time range from where clauses.
 *
 * Looks for patterns like:
 *   start_time > @2014-01-01 and start_time < @2014-04-01
 *   start_time ? @2014-01 to @2014-03
 *   start_time >= @2014-01-01
 */
export function extractTimeRange(malloy: string): SessionTimeRange | null {
  // Pattern: column > @date and column < @date  (or >= / <=)
  const rangeMatch = malloy.match(
    /(\w[\w.]*)\s*>=?\s*@(\d{4}[\d-]*T?[\d:.]*Z?)\s*(?:and|,)\s*\1\s*<=?\s*@(\d{4}[\d-]*T?[\d:.]*Z?)/i,
  );
  if (rangeMatch) {
    return { column: rangeMatch[1], start: rangeMatch[2], end: rangeMatch[3] };
  }

  // Pattern: column ? @date to @date
  const toMatch = malloy.match(
    /(\w[\w.]*)\s*\?\s*@(\d{4}[\d-]*T?[\d:.]*Z?)\s+to\s+@(\d{4}[\d-]*T?[\d:.]*Z?)/i,
  );
  if (toMatch) {
    return { column: toMatch[1], start: toMatch[2], end: toMatch[3] };
  }

  return null;
}
