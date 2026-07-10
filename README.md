# rowset-diff

**Diff two sets of rows by key** — get back what was added, removed, and changed
down to the field. Match on a key you name, so the diff is immune to row order
and to volatile columns like `updated_at`. Zero dependencies, TypeScript-first.

```bash
npm i rowset-diff
```

## Why

Generic deep-diff libraries (`deep-diff`, `microdiff`) compare arrays **by
position**. Reorder the rows — which any `ORDER BY` change or re-fetch does — and
they report that *every* row changed, burying the one real difference. `rowset-diff`
matches rows **by key**, so only the true differences survive.

```ts
import { rowsetDiff } from 'rowset-diff';

const before = [
  { order_id: 'A-1001', total: 1240, status: 'paid' },
  { order_id: 'A-1002', total: 899.5, status: 'paid' },
  { order_id: 'A-1003', total: 50, status: 'refunded' },
];

// a rewritten query: rows reordered, and one silently dropped
const after = [
  { order_id: 'A-1002', total: 899.5, status: 'paid' },
  { order_id: 'A-1001', total: 1240, status: 'paid' },
];

rowsetDiff(before, after, 'order_id');
// {
//   added:   [],
//   removed: [{ order_id: 'A-1003', total: 50, status: 'refunded' }],
//   changed: [],
//   same:    false,
// }
// The reorder is ignored; the dropped row is the only finding.
```

## Real-world use

**Reconciliation** — ERP export vs. bank statement:

```ts
rowsetDiff(erp, bank, 'invoice_no');
// changed: [{ key: '050-50470012', fields: { amount: { from: 1290, to: 1250 } } }]
// added:   [{ invoice_no: '050-50470099', vendor: 'FedEx', amount: 212.1 }]
```

**Deploy safety** — API list response before vs. after, ignoring timestamp churn:

```ts
rowsetDiff(v1, v2, 'id', { ignore: ['updated_at'] });
// only real field changes survive; rows whose only delta is updated_at are silent
```

**Replication** — source vs. replica on a composite key:

```ts
rowsetDiff(source, replica, ['store_id', 'sku']);
// removed: [{ store_id: 'SEA', sku: 'A101', qty: 12 }]  // failed to sync
```

**Regression test** — prove a query rewrite returns identical rows:

```ts
import { assertSameRows } from 'rowset-diff';

assertSameRows(oldQuery, newQuery, 'id');
// throws with the diff AS the message when they drift:
//   rowsetDiff: row sets differ:
//   ~ 4082  total 1200 -> 1180
//   - { id: 4090, ... }
```

## API

### `rowsetDiff(before, after, key, options?)`

| Param | Type | |
|---|---|---|
| `before` | `T[]` | baseline rows |
| `after` | `T[]` | rows to compare |
| `key` | `string \| string[]` | field name, or field names for a composite key |
| `options` | `RowsetDiffOptions` | see below |

Returns:

```ts
interface RowsetDiffResult<T> {
  added: T[];      // key in `after` only (after-order)
  removed: T[];    // key in `before` only (before-order)
  changed: {
    key: unknown;                             // scalar, or { [field]: value } for composite
    fields: Record<string, { from; to }>;     // only the fields that differ
    before: T;
    after: T;
  }[];
  same: boolean;   // true when added + removed + changed are all empty
}
```

### `RowsetDiffOptions`

| Option | Type | Default | |
|---|---|---|---|
| `ignore` | `string[]` | — | compare every field except these (and the key) |
| `fields` | `string[]` | — | compare only these fields (the key is always excluded) |
| `equals` | `(from, to, field) => boolean` | deep-equal | custom field equality, e.g. money tolerance |
| `duplicates` | `'throw' \| 'keep-first' \| 'keep-last'` | `'throw'` | a duplicate key usually means the key isn't unique — surfaced loudly by default |

### Helpers

- **`assertSameRows(before, after, key, options?)`** — throws when the sets differ; the error message is the formatted diff and the structured result is attached as `error.diff`. Returns the (empty) diff when equal.
- **`formatRowsetDiff(result)`** — render a result as a git-style text block (`-` removed, `+` added, `~` changed).
- **`defaultEquals(a, b)`** — the built-in structural equality (primitives incl. `NaN`, `Date` by time, arrays, plain objects).

## Notes

- **Composite keys** are encoded so distinct rows can't collide when their key parts are joined (`['x','yz']` ≠ `['xy','z']`).
- **`Date` values** compare by time, not reference; nested objects/arrays compare structurally.
- Not a total blank space: [`jsondiffpatch`](https://github.com/benjamine/jsondiffpatch) can match arrays by key via `objectHash`. `rowset-diff` is the small, tabular-first alternative whose output is a readable `added / removed / changed` report you can log, assert on, or render — rather than a patch document.

## License

MIT © Hojoong Kim
