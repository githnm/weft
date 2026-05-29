/**
 * Comprehensive Malloy syntax reference derived from the Malloy language
 * specification and compiler AST. Covers every place Malloy diverges
 * from SQL, with WRONG (SQL) vs RIGHT (Malloy) examples.
 *
 * This is the backstop: the LLM sees this reference in every prompt.
 * Combined with per-measure compile validation (the mechanism) and
 * semantic verification (the semantic check), this forms the three-layer
 * defense against SQL-idiom errors.
 */

export const MALLOY_SYNTAX_RULES = `MALLOY SYNTAX RULES:
- measure: name is expression  (aggregation like count(), sum(), avg())
- dimension: name is expression  (scalar computation or cast)
- view: name is { group_by: ..., aggregate: ..., where: ..., limit: ... }
- where: condition  (filter — at source level applies globally, in views applies locally)
- Filtered aggregates: count() { where: condition } or sum(col) { where: condition }
- Do NOT use \`dimension:\` to redeclare columns that already exist on the source table. Malloy exposes all source columns automatically. Only use \`dimension:\` for NEW computed fields.
- When proposing a join-traversing measure, only reference joins that already exist in the .malloy file.
- If a column is annotated [aggregate as: expr] in the catalog, use that expression in aggregates (e.g. count(user_id::string) not count(user_id)).`;

export const MALLOY_SYNTAX_REFERENCE = `MALLOY SYNTAX REFERENCE — COMPREHENSIVE

Malloy is NOT SQL. This reference covers every divergence from SQL that causes
compile errors or wrong semantics. Each section shows the SQL pattern (WRONG)
and the Malloy equivalent (RIGHT). Rules derived from the Malloy v0.0.400
compiler grammar and AST.

═══ AGGREGATES ═══

A1. count() vs count(column) — CRITICAL DISTINCTION
  count()           → row count     (verified SQL: COUNT(*))
  count(column)     → distinct count (verified SQL: COUNT(DISTINCT column))

  count(col) IS the distinct count. Do NOT add "distinct" —
  count(distinct col) is deprecated and errors.

  For row count:              count()
  For distinct count:         count(column)
  For UUID columns:           count(column::string)

  WRONG: count(distinct email)    — "distinct" keyword errors
  RIGHT: count(email)             — this IS the distinct count (SQL: COUNT(DISTINCT email))
  RIGHT: count()                  — total rows (SQL: COUNT(*))

A2. Aggregate function forms — BOTH styles are valid (verified)
  Function-style:  sum(col), min(col), max(col)      (verified: identical SQL)
  Method-style:    col.sum(), col.avg(), col.min(), col.max()  (verified: identical SQL)

  WRONG: sum()          — sum/avg REQUIRE an argument
  WRONG: avg()          — sum/avg REQUIRE an argument
  RIGHT: sum(amount)    — function-style (verified SQL: SUM(amount))
  RIGHT: amount.sum()   — method-style   (verified SQL: SUM(amount))

  Note: count(col) is the distinct count (see A1). Both function and method
  styles produce identical SQL for sum/avg/min/max.

A3. Filtered aggregates — use \`{ where: }\` block
  WRONG: COUNT(CASE WHEN status='active' THEN 1 END)
  WRONG: SUM(IF(active, amount, 0))
  RIGHT: count() { where: status = 'active' }
  RIGHT: amount.sum() { where: is_active }

A4. All aggregations in a view must be named
  WRONG: aggregate: row_count, duration.avg()
  RIGHT: aggregate:
           row_count
           avg_duration is duration.avg()

  Pre-defined measures (like row_count) can be bare. New expressions need \`name is\`.

A5. Measures MUST be aggregate; dimensions MUST be scalar
  WRONG: measure: full_name is concat(first_name, ' ', last_name)    — scalar
  RIGHT: dimension: full_name is concat(first_name, ' ', last_name)

  WRONG: dimension: total is amount.sum()    — aggregate
  RIGHT: measure: total is amount.sum()

A6. Connector-driven type safety in aggregates
  Some native types can't go directly into aggregates. If the table catalog
  annotates a column with [aggregate as: expr], USE that expression.

  Example: Postgres UUID columns need ::string for count():
    WRONG: count(user_id)            — UUID type not countable
    RIGHT: count(user_id::string)    — cast first

  This applies to ALL aggregate functions on such columns, not just count().
  Always check the catalog annotation.

A7. Division: define named measures first
  WRONG: measure: pct is (count() { where: x }) / count() * 100
  RIGHT: measure: filtered is count() { where: x }
         measure: pct is filtered / total * 100

═══ EXPRESSIONS ═══

E1. String concatenation: concat(), NOT ||
  WRONG: first_name || ' ' || last_name
  RIGHT: concat(first_name, ' ', last_name)
  Multiple args: concat(city, ', ', state, ' ', zip)

E2. Null checks: \`is null\` / \`is not null\`
  WRONG: x = null, x != null, x <> null, x == null
  RIGHT: x is null, x is not null

E3. Conditional: pick/when/else (preferred) or CASE/WHEN/END
  Both forms compile. pick/when/else is idiomatic Malloy:
  PREFERRED: pick 'yes' when status = 'active' else 'no'
  ALSO VALID: CASE WHEN status = 'active' THEN 'yes' ELSE 'no' END

  Multi-branch (pick/when preferred):
  pick 'high' when amount > 1000
  pick 'medium' when amount > 100
  else 'low'

E4. Coalesce: coalesce(), NOT ?? or IFNULL or NVL
  WRONG: x ?? default_value
  WRONG: IFNULL(x, default_value)
  RIGHT: coalesce(x, default_value)

E5. String functions
  VALID: concat(), upper(), lower(), length(), substr()
  WRONG: ILIKE (Postgres-specific)
  RIGHT: ~ (Malloy match operator for pattern matching)
  RIGHT: column ~ r'pattern' for regex

E6. Type casting uses :: (Postgres-style)
  RIGHT: column::string, column::number, column::date
  WRONG: CAST(column AS VARCHAR)

E7. Boolean dimensions — comparisons are valid expressions
  dimension: is_premium is amount > 1000      — produces true/false
  dimension: is_active is status = 'active'   — valid
  dimension: has_email is email is not null    — valid

═══ FILTERS ═══

F1. Value-set filter: column = 'a' | 'b' | 'c'
  WRONG: column = 'a' OR column = 'b' OR column = 'c'
  WRONG: column IN ('a', 'b', 'c')
  RIGHT: column = 'a' | 'b' | 'c'

  The | operator is the value-set separator. Column appears once on the left.

F2. Composing with 'and'
  RIGHT: column1 = 'x' and column2 > 10
  WRONG: column1 = 'a' | column1 = 'b'     — don't repeat the column

  When combining value-set with other conditions:
  RIGHT: (subscriber_type = 'A' | 'B') and start_time >= @2024-01-01

F3. Source-level where: applies globally — NO named form
  WRONG (at source level): where: is_active is status = 'active'
  RIGHT (use dimension): dimension: is_active is status = 'active'
  Then use: count() { where: is_active }

  Source-level where: just takes a condition:
    where: status = 'active'

═══ TIME ═══

T1. Time truncation uses dot-access
  VALID:   .year, .quarter, .month, .week, .day, .hour, .minute, .second
  INVALID: .day_of_week, .day_of_year, .weekday, .week_of_year

  RIGHT: dimension: event_month is created_at.month
  WRONG: dimension: event_month is DATE_TRUNC('month', created_at)

T2. Date literals use @ prefix
  RIGHT: start_time > @2024-01-01
  RIGHT: start_time = @2024-06-15
  WRONG: start_time > '2024-01-01'    — string, not date

T3. Time intervals
  RIGHT: start_time > now - 7 days
  Note: \`now\` may not be available in all contexts. Prefer @YYYY-MM-DD literals.

═══ JOINS ═══

J1. Explicit ON clause required — no shortcuts
  WRONG: join_one: users is users_table with primary_key
  WRONG: join_one: users is users_table USING (user_id)
  RIGHT: join_one: users is users_table on user_id = users.id

J2. Joined sources must be declared BEFORE the primary source
  RIGHT:
    source: users_dim is postgres.table('public.users') extend { primary_key: id }
    source: events is postgres.table('public.events') extend {
      join_one: user_info is users_dim on user_id = user_info.id
    }

J3. Access joined fields with dot notation
  RIGHT: user_info.name, user_info.email
  WRONG: name (ambiguous — could be from any joined table)

J4. primary_key: is a source-level declaration
  RIGHT: source: users is ... extend { primary_key: id }
  Not a join keyword. Separate from join syntax.

═══ STRUCTURE ═══

S1. No import statements — models must be self-contained
  WRONG: import "other_model.malloy"
  RIGHT: Declare all sources inline using connector table expressions

S2. Do NOT redeclare existing source columns
  WRONG: dimension: email is email          — already exists, causes shadow
  WRONG: dimension: status is upper(status) — name collision
  RIGHT: dimension: status_label is upper(status)
  Use suffixes: _label, _group, _bucket, _flag, _derived, _total

S3. Source declaration
  BigQuery: source: name is bigquery.table('project.dataset.table') extend { ... }
  Postgres: source: name is postgres.table('schema.table') extend { ... }

S4. View structure
  view: name is {
    group_by: dimension1, dimension2
    aggregate: measure1, measure2
    where: condition
    order_by: dimension1 desc
    limit: 100
  }

═══ QUERY SHAPES — complex patterns (verified to compile) ═══

Q1. Nesting — \`nest:\` goes INSIDE the query block, never outside
  A nested aggregation is a sub-result computed per outer group. It is a field
  of the query body, alongside group_by/aggregate — NOT a separate statement.

  WRONG (nest outside the block):
    run: src -> { group_by: region; aggregate: total is count() }
    nest: by_city is { group_by: city; aggregate: n is count() }
  RIGHT (nest inside the block):
    run: src -> {
      group_by: region
      aggregate: total is count()
      nest: by_city is {
        group_by: city
        aggregate: n is count()
        limit: 5
      }
      limit: 10
    }
  Verified: compiles; emits a grouped-set nested aggregation.

Q2. Ratio of two aggregates — divide aggregates, guard the denominator
  A rate/ratio is a MEASURE (or a named aggregate in the body): one aggregate
  divided by another. ALWAYS guard with nullif(denominator, 0) against
  divide-by-zero. Do NOT improvise window functions or subqueries for a ratio.

  RIGHT (as measures):
    measure: accounts_with_opps is count() { where: opp_summary.opp_id is not null }
    measure: accounts_with_sessions is count() { where: session_summary.session_id is not null }
    measure: session_to_opp_rate is accounts_with_opps / nullif(accounts_with_sessions, 0)
  RIGHT (inline in a query body):
    aggregate:
      rows_total is count()
      distinct_users is count(user_id)
      ratio is count() / nullif(count(user_id), 0)
  Verified SQL: COUNT(1)/(NULLIF(count(distinct ...), 0))

Q3. Time grouping — group_by a time truncation directly
  RIGHT:
    run: src -> {
      group_by: created_at.month
      aggregate: n is count()
      order_by: created_at.month
      limit: 12
    }
  Truncations: .year .quarter .month .week .day .hour (see T1).
  Verified SQL: TIMESTAMP(DATETIME_TRUNC(DATETIME(created_at,'UTC'), month),'UTC')
  To reuse a time grouping as a field, declare a dimension:
    dimension: created_month is created_at.month

CRITICAL: When in doubt, prefer simple expressions that compile over clever
expressions that might fail. A working count() is better than a broken
complex aggregate. For nesting, ratios, and time grouping, use the verified
Q1–Q3 patterns above — do not improvise the structure.`;
