import { describe, it, expect } from 'vitest';
import {
  rowsetDiff,
  assertSameRows,
  formatRowsetDiff,
  defaultEquals,
} from '../src/index.js';

describe('rowsetDiff — matching by key, not position', () => {
  it('ignores row reorder (the whole point)', () => {
    const before = [
      { id: 'A-1001', total: 1240, status: 'paid' },
      { id: 'A-1002', total: 899.5, status: 'paid' },
    ];
    // same rows, reversed order
    const after = [
      { id: 'A-1002', total: 899.5, status: 'paid' },
      { id: 'A-1001', total: 1240, status: 'paid' },
    ];
    const diff = rowsetDiff(before, after, 'id');
    expect(diff.same).toBe(true);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
  });

  it('reports removed rows regardless of order', () => {
    const before = [
      { id: 'A-1001', total: 1240 },
      { id: 'A-1002', total: 899.5 },
      { id: 'A-1003', total: 50 },
    ];
    const after = [
      { id: 'A-1002', total: 899.5 },
      { id: 'A-1001', total: 1240 },
    ];
    const diff = rowsetDiff(before, after, 'id');
    expect(diff.same).toBe(false);
    expect(diff.removed).toEqual([{ id: 'A-1003', total: 50 }]);
    expect(diff.added).toEqual([]);
    expect(diff.changed).toEqual([]);
  });

  it('reports added rows', () => {
    const before = [{ id: 1 }];
    const after = [{ id: 1 }, { id: 2 }];
    const diff = rowsetDiff(before, after, 'id');
    expect(diff.added).toEqual([{ id: 2 }]);
    expect(diff.removed).toEqual([]);
  });
});

describe('rowsetDiff — field-level changes', () => {
  it('captures per-field from/to', () => {
    const before = [{ id: 1, role: 'admin', name: 'Ada' }];
    const after = [{ id: 1, role: 'owner', name: 'Ada' }];
    const diff = rowsetDiff(before, after, 'id');
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0]!.key).toBe(1);
    expect(diff.changed[0]!.fields).toEqual({ role: { from: 'admin', to: 'owner' } });
    expect(diff.changed[0]!.before).toEqual(before[0]);
    expect(diff.changed[0]!.after).toEqual(after[0]);
  });

  it('treats a field present on one side only as a change to/from undefined', () => {
    const before = [{ id: 1, a: 1 }];
    const after = [{ id: 1, a: 1, b: 2 }];
    const diff = rowsetDiff(before, after, 'id');
    expect(diff.changed[0]!.fields).toEqual({ b: { from: undefined, to: 2 } });
  });
});

describe('rowsetDiff — ignore / fields selection', () => {
  it('ignore strips volatile columns (updated_at churn)', () => {
    const v1 = [
      { id: 1, role: 'admin', updated_at: '10:00' },
      { id: 2, role: 'user', updated_at: '10:00' },
    ];
    const v2 = [
      { id: 1, role: 'owner', updated_at: '12:30' }, // real change + timestamp
      { id: 2, role: 'user', updated_at: '12:31' }, // ONLY the timestamp moved
    ];
    const diff = rowsetDiff(v1, v2, 'id', { ignore: ['updated_at'] });
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0]!.key).toBe(1);
    expect(diff.changed[0]!.fields).toEqual({ role: { from: 'admin', to: 'owner' } });
  });

  it('fields limits comparison to a whitelist', () => {
    const before = [{ id: 1, total: 100, note: 'x' }];
    const after = [{ id: 1, total: 100, note: 'y' }];
    const diff = rowsetDiff(before, after, 'id', { fields: ['total'] });
    expect(diff.same).toBe(true); // note change ignored because it's not in `fields`
  });

  it('never diffs the key field itself', () => {
    const before = [{ id: 1, v: 1 }];
    const after = [{ id: 1, v: 1 }];
    const diff = rowsetDiff(before, after, 'id');
    expect(diff.same).toBe(true);
  });
});

describe('rowsetDiff — composite keys', () => {
  it('matches on a composite key and finds the un-synced row', () => {
    const source = [
      { store_id: 'SEA', sku: 'A100', qty: 40 },
      { store_id: 'SEA', sku: 'A101', qty: 12 },
      { store_id: 'LAX', sku: 'A100', qty: 7 },
    ];
    const replica = [
      { store_id: 'SEA', sku: 'A100', qty: 40 },
      { store_id: 'LAX', sku: 'A100', qty: 7 },
    ];
    const diff = rowsetDiff(source, replica, ['store_id', 'sku']);
    expect(diff.removed).toEqual([{ store_id: 'SEA', sku: 'A101', qty: 12 }]);
    expect(diff.changed).toEqual([]);
  });

  it('returns a composite key as an object on changes', () => {
    const before = [{ store_id: 'SEA', sku: 'A100', qty: 40 }];
    const after = [{ store_id: 'SEA', sku: 'A100', qty: 41 }];
    const diff = rowsetDiff(before, after, ['store_id', 'sku']);
    expect(diff.changed[0]!.key).toEqual({ store_id: 'SEA', sku: 'A100' });
    expect(diff.changed[0]!.fields).toEqual({ qty: { from: 40, to: 41 } });
  });

  it('does not merge distinct composite keys that would collide when joined', () => {
    // ['a','b'] joined naively as "a|b" would collide with ['a|b'] etc.
    const before = [
      { p: 'x', q: 'yz', v: 1 },
      { p: 'xy', q: 'z', v: 2 },
    ];
    const after = [
      { p: 'x', q: 'yz', v: 1 },
      { p: 'xy', q: 'z', v: 9 },
    ];
    const diff = rowsetDiff(before, after, ['p', 'q']);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0]!.key).toEqual({ p: 'xy', q: 'z' });
  });
});

describe('rowsetDiff — custom equality (money tolerance)', () => {
  it('treats amounts within a tolerance as equal', () => {
    const before = [{ id: 1, amount: 100.0 }];
    const after = [{ id: 1, amount: 100.004 }];
    const money = (a: unknown, b: unknown, field: string) =>
      field === 'amount' ? Math.abs(Number(a) - Number(b)) < 0.005 : defaultEquals(a, b);
    expect(rowsetDiff(before, after, 'id', { equals: money }).same).toBe(true);
    // without tolerance it IS a change
    expect(rowsetDiff(before, after, 'id').same).toBe(false);
  });
});

describe('defaultEquals — value semantics', () => {
  it('compares Dates by time, not reference', () => {
    const before = [{ id: 1, at: new Date('2026-01-01T00:00:00Z') }];
    const after = [{ id: 1, at: new Date('2026-01-01T00:00:00Z') }];
    expect(rowsetDiff(before, after, 'id').same).toBe(true);
  });

  it('deep-compares nested objects and arrays', () => {
    const before = [{ id: 1, tags: ['a', 'b'], meta: { n: 1 } }];
    const after = [{ id: 1, tags: ['a', 'b'], meta: { n: 1 } }];
    expect(rowsetDiff(before, after, 'id').same).toBe(true);
    const changed = rowsetDiff(before, [{ id: 1, tags: ['a', 'c'], meta: { n: 1 } }], 'id');
    expect(changed.changed[0]!.fields.tags).toBeDefined();
  });

  it('treats NaN as equal to NaN', () => {
    expect(defaultEquals(NaN, NaN)).toBe(true);
  });
});

describe('rowsetDiff — correctness guards', () => {
  it('throws on duplicate keys by default', () => {
    const rows = [
      { id: 1, v: 'a' },
      { id: 1, v: 'b' },
    ];
    expect(() => rowsetDiff(rows, [], 'id')).toThrow(/duplicate key/);
  });

  it('keep-last collapses duplicates instead of throwing', () => {
    const before = [
      { id: 1, v: 'a' },
      { id: 1, v: 'b' },
    ];
    const after = [{ id: 1, v: 'b' }];
    const diff = rowsetDiff(before, after, 'id', { duplicates: 'keep-last' });
    expect(diff.same).toBe(true);
  });

  it('keep-first wins for the first occurrence', () => {
    const before = [
      { id: 1, v: 'a' },
      { id: 1, v: 'b' },
    ];
    const after = [{ id: 1, v: 'a' }];
    expect(rowsetDiff(before, after, 'id', { duplicates: 'keep-first' }).same).toBe(true);
  });

  it('throws when a row is missing the key field', () => {
    expect(() => rowsetDiff([{ id: 1 }], [{ nope: 2 }], 'id')).toThrow(/missing key field "id"/);
  });

  it('throws on an empty key', () => {
    expect(() => rowsetDiff([], [], [])).toThrow(/at least one field/);
  });
});

describe('assertSameRows + formatRowsetDiff', () => {
  it('assertSameRows returns the empty diff when equal', () => {
    const rows = [{ id: 1, v: 1 }];
    expect(assertSameRows(rows, rows, 'id').same).toBe(true);
  });

  it('assertSameRows throws a diff-shaped message and attaches .diff', () => {
    const before = [{ id: 1, total: 1200 }];
    const after = [{ id: 1, total: 1180 }];
    try {
      assertSameRows(before, after, 'id');
      throw new Error('should have thrown');
    } catch (e) {
      const err = e as Error & { diff?: unknown };
      expect(err.message).toContain('total 1200 -> 1180');
      expect(err.diff).toBeDefined();
    }
  });

  it('formats added / removed / changed as a git-style block', () => {
    const before = [
      { id: 1, total: 1200 },
      { id: 3, total: 50 },
    ];
    const after = [
      { id: 1, total: 1180 },
      { id: 4, total: 9 },
    ];
    const text = formatRowsetDiff(rowsetDiff(before, after, 'id'));
    expect(text).toContain('- { id: 3');
    expect(text).toContain('+ { id: 4');
    expect(text).toContain('~ 1  total 1200 -> 1180');
  });

  it('formats an empty diff explicitly', () => {
    expect(formatRowsetDiff(rowsetDiff([{ id: 1 }], [{ id: 1 }], 'id'))).toBe('(no differences)');
  });
});
