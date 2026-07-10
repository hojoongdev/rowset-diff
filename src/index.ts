/**
 * rowset-diff — diff two sets of rows by key.
 *
 * Generic deep-diff libraries compare arrays by POSITION, so reordering the
 * rows (any `ORDER BY` change, any re-fetch) reports that every row changed.
 * rowset-diff matches rows by a key you name, so only the real differences
 * survive: what was added, what was removed, and — down to the field — what
 * changed. Composite keys, `ignore` for volatile columns, and a pluggable
 * equality function (e.g. money-rounding tolerance) are first-class.
 *
 * Zero runtime dependencies.
 */

export type Row = Record<string, unknown>;

export interface RowsetDiffOptions {
  /**
   * Only compare these fields (the key is always excluded). Use this when a row
   * carries many columns but only a few are meaningful. Mutually composable with
   * `ignore`: `fields` selects, then `ignore` subtracts.
   */
  fields?: string[];
  /**
   * Compare every field EXCEPT these. The classic use is stripping volatile
   * columns — `updated_at`, `etag`, `_synced` — that otherwise flag every row.
   * The key fields are always ignored regardless of this list.
   */
  ignore?: string[];
  /**
   * Custom field equality. Return `true` when the two values should count as
   * equal. Handy for tolerances (e.g. treat amounts within 0.005 as equal) or
   * for normalizing before comparing. Defaults to a structural deep-equal that
   * understands primitives, `Date`, arrays, and plain objects.
   */
  equals?: (before: unknown, after: unknown, field: string) => boolean;
  /**
   * What to do when ONE side contains two rows with the same key — which almost
   * always means the key you chose is not actually unique. Default `'throw'`
   * surfaces that bug loudly; `'keep-first'` / `'keep-last'` opt into silently
   * collapsing duplicates.
   */
  duplicates?: 'throw' | 'keep-first' | 'keep-last';
}

export interface FieldChange {
  from: unknown;
  to: unknown;
}

export interface RowChange<T extends Row = Row> {
  /** Scalar value for a single key; `{ [field]: value }` for a composite key. */
  key: unknown;
  /** The fields that differ, each with its `from` / `to` value. */
  fields: Record<string, FieldChange>;
  /** The full matched rows, for context (log, render, drill in). */
  before: T;
  after: T;
}

export interface RowsetDiffResult<T extends Row = Row> {
  /** Rows whose key exists only in `after` (source order preserved). */
  added: T[];
  /** Rows whose key exists only in `before` (source order preserved). */
  removed: T[];
  /** Rows present on both sides with at least one differing field. */
  changed: RowChange<T>[];
  /** `true` when `added`, `removed`, and `changed` are all empty. */
  same: boolean;
}

/** Structural deep-equal: primitives (incl. NaN), Date by time, arrays, plain objects. */
export function defaultEquals(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    const aArr = Array.isArray(a);
    if (aArr !== Array.isArray(b)) return false;
    if (aArr) {
      const x = a as unknown[];
      const y = b as unknown[];
      if (x.length !== y.length) return false;
      return x.every((v, i) => defaultEquals(v, y[i]));
    }
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ak = Object.keys(ao);
    const bk = Object.keys(bo);
    if (ak.length !== bk.length) return false;
    return ak.every(
      (k) => Object.prototype.hasOwnProperty.call(bo, k) && defaultEquals(ao[k], bo[k]),
    );
  }
  return false;
}

function normalizeKeys(key: string | string[]): string[] {
  const keys = Array.isArray(key) ? key : [key];
  if (keys.length === 0) throw new Error('rowsetDiff: `key` must name at least one field.');
  return keys;
}

/** Stable identity string for a row's key — JSON-encodes the parts so type and
 *  separator collisions can't merge distinct rows (1 vs '1', ['a','b'] joins). */
function keyId<T extends Row>(row: T, keys: string[], side: string, index: number): string {
  const parts = keys.map((k) => {
    if (!(k in row)) {
      throw new Error(`rowsetDiff: row at ${side}[${index}] is missing key field "${k}".`);
    }
    return row[k];
  });
  return JSON.stringify(parts);
}

/** The key value shape returned on a change: scalar for one key, object for many. */
function keyValue<T extends Row>(row: T, keys: string[]): unknown {
  if (keys.length === 1) return row[keys[0] as string];
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = row[k];
  return out;
}

function indexBySide<T extends Row>(
  rows: readonly T[],
  keys: string[],
  side: 'before' | 'after',
  duplicates: NonNullable<RowsetDiffOptions['duplicates']>,
): Map<string, T> {
  if (!Array.isArray(rows)) {
    throw new Error(`rowsetDiff: \`${side}\` must be an array of rows.`);
  }
  const map = new Map<string, T>();
  rows.forEach((row, i) => {
    const id = keyId(row, keys, side, i);
    if (map.has(id)) {
      if (duplicates === 'throw') {
        throw new Error(
          `rowsetDiff: duplicate key ${id} in \`${side}\` (index ${i}). ` +
            `The chosen key is not unique — pass { duplicates: 'keep-first' | 'keep-last' } to allow.`,
        );
      }
      if (duplicates === 'keep-first') return;
    }
    map.set(id, row);
  });
  return map;
}

function changedFields<T extends Row>(
  before: T,
  after: T,
  keys: string[],
  options: RowsetDiffOptions,
): Record<string, FieldChange> {
  const eq = options.equals ?? defaultEquals;
  const ignore = new Set<string>([...(options.ignore ?? []), ...keys]);
  const names = options.fields
    ? options.fields.filter((f) => !ignore.has(f))
    : [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((f) => !ignore.has(f));

  const changes: Record<string, FieldChange> = {};
  for (const f of names) {
    const from = before[f];
    const to = after[f];
    if (!eq(from, to, f)) changes[f] = { from, to };
  }
  return changes;
}

/**
 * Diff two sets of rows by key.
 *
 * @param before  the baseline rows
 * @param after   the rows to compare against the baseline
 * @param key     a field name, or an array of field names for a composite key
 * @param options see {@link RowsetDiffOptions}
 *
 * @example
 * rowsetDiff(erp, bank, 'invoice_no')
 * rowsetDiff(source, replica, ['store_id', 'sku'])
 * rowsetDiff(v1, v2, 'id', { ignore: ['updated_at'] })
 */
export function rowsetDiff<T extends Row = Row>(
  before: readonly T[],
  after: readonly T[],
  key: string | string[],
  options: RowsetDiffOptions = {},
): RowsetDiffResult<T> {
  const keys = normalizeKeys(key);
  const duplicates = options.duplicates ?? 'throw';

  const beforeIndex = indexBySide(before, keys, 'before', duplicates);
  const afterIndex = indexBySide(after, keys, 'after', duplicates);

  const added: T[] = [];
  const removed: T[] = [];
  const changed: RowChange<T>[] = [];

  // Preserve `after` order for added rows.
  for (const [id, row] of afterIndex) {
    if (!beforeIndex.has(id)) added.push(row);
  }

  // Preserve `before` order for removed + changed rows.
  for (const [id, beforeRow] of beforeIndex) {
    const afterRow = afterIndex.get(id);
    if (afterRow === undefined) {
      removed.push(beforeRow);
      continue;
    }
    const fields = changedFields(beforeRow, afterRow, keys, options);
    if (Object.keys(fields).length > 0) {
      changed.push({ key: keyValue(beforeRow, keys), fields, before: beforeRow, after: afterRow });
    }
  }

  return { added, removed, changed, same: added.length === 0 && removed.length === 0 && changed.length === 0 };
}

/**
 * Throw if the two row sets are not identical (by {@link rowsetDiff}). The thrown
 * error's message IS the diff — exactly which rows and fields drifted — and the
 * structured result is attached as `error.diff`. Returns the (empty) diff when equal.
 *
 * @example
 * assertSameRows(oldQuery, newQuery, 'id');            // in a test
 * assertSameRows(oldQuery, newQuery, 'id', { ignore: ['updated_at'] });
 */
export function assertSameRows<T extends Row = Row>(
  before: readonly T[],
  after: readonly T[],
  key: string | string[],
  options: RowsetDiffOptions = {},
): RowsetDiffResult<T> {
  const diff = rowsetDiff(before, after, key, options);
  if (!diff.same) {
    const error = new Error(`rowsetDiff: row sets differ:\n${formatRowsetDiff(diff)}`);
    (error as Error & { diff?: RowsetDiffResult<T> }).diff = diff;
    throw error;
  }
  return diff;
}

function compact(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return JSON.stringify(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function compactRow(row: Row): string {
  const parts = Object.entries(row).map(([k, v]) => `${k}: ${compact(v)}`);
  return `{ ${parts.join(', ')} }`;
}

function keyLabel(key: unknown): string {
  if (key !== null && typeof key === 'object') {
    return Object.entries(key as Record<string, unknown>)
      .map(([k, v]) => `${k}=${compact(v)}`)
      .join(', ');
  }
  return compact(key);
}

/**
 * Render a {@link RowsetDiffResult} as a git-style text block:
 * `-` removed, `+` added, `~` changed (with `from -> to` per field). Zero-dep,
 * no color — this is the string `assertSameRows` throws on failure.
 */
export function formatRowsetDiff(result: RowsetDiffResult): string {
  const lines: string[] = [];
  for (const row of result.removed) lines.push(`- ${compactRow(row)}`);
  for (const row of result.added) lines.push(`+ ${compactRow(row)}`);
  for (const change of result.changed) {
    const deltas = Object.entries(change.fields)
      .map(([field, { from, to }]) => `${field} ${compact(from)} -> ${compact(to)}`)
      .join(', ');
    lines.push(`~ ${keyLabel(change.key)}  ${deltas}`);
  }
  return lines.length ? lines.join('\n') : '(no differences)';
}

export default rowsetDiff;
