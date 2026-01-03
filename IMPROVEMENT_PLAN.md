# Architecture Improvement Plan

Analysis of the mailbox-mcp-server codebase revealed several opportunities for simplification and improved maintainability.

## Priority 1: Remove Dead Code

### DynamicPoolManager is Non-Functional

The `DynamicPoolManager` runs a 30-second adjustment cycle but **never receives any metrics**. The pools never call `updatePoolStats()`.

**Options:**
1. **Remove it entirely** - Simplest solution. The current static pool configuration works fine.
2. **Wire it up properly** - Add metric collection calls from `ConnectionPool` to the manager.

**Recommendation:** Remove it. The feature adds complexity without delivering value. Static pool sizing with the existing health checks is sufficient for this use case.

**Files to modify:**
- Delete `src/services/DynamicPoolManager.ts`
- Remove registration code from `src/main.ts` (lines 160-168)
- Simplify `config.ts` pool configuration

---

## Priority 2: Extract Cache Fallback Pattern

Five methods follow identical cache-with-fallback logic (~300 lines total):

```typescript
// Pattern repeated in:
// - EmailService.searchEmails()
// - EmailService.getEmail()
// - EmailService.getFolders()
// - CalendarService.getCalendarEvents()
// - CalendarService.searchCalendar()

// Check cache → Try fresh fetch → Catch error → Return stale cache → Return default
```

**Recommendation:** Create a `CachedOperation<T>` utility:

```typescript
async function withCacheFallback<T>(options: {
  cacheKey: string;
  cache: LocalCache;
  fetch: () => Promise<T>;
  defaultValue: T;
  logger: Logger;
}): Promise<T>
```

**Benefits:**
- Reduces ~300 lines to ~50
- Consistent error handling
- Single place to tune caching behavior

---

## Priority 3: Split EmailService

`EmailService.ts` is **1,277 lines** - too large to maintain easily.

**Recommended split:**

| New Service | Responsibility | Approximate Lines |
|-------------|----------------|-------------------|
| `EmailSearchService` | Search queries, filtering, criteria building | ~400 |
| `EmailFolderService` | Folder CRUD, listing, hierarchy | ~200 |
| `EmailOperationsService` | Move, mark, delete, create draft | ~300 |
| `EmailService` | Facade coordinating the above + fetch single/batch | ~300 |

**Alternative (simpler):** Extract just the search query builder into a separate `SearchQueryBuilder` class. This addresses the most complex part without a full refactor.

---

## Priority 4: Consolidate Duplicate Code

### Address Parsing (2 identical methods)

```typescript
// EmailService.ts lines 683-715
parseAddressesFromEnvelope()  // These are functionally
parseAddressesFromParsed()    // identical - merge them
```

**Fix:** Single `parseAddresses(field: AddressObject | Address[])` method.

### Connection Resource Pattern (5+ occurrences)

```typescript
let wrapper = null;
try {
  wrapper = await this.pool.acquireForFolder(folder);
  // operation
} finally {
  if (wrapper) await this.pool.releaseFromFolder(wrapper);
}
```

**Fix:** Add helper method:

```typescript
async withConnection<T>(folder: string, operation: (conn) => Promise<T>): Promise<T>
```

---

## Priority 5: Fix Type Inconsistency

`main.ts` has a type assertion workaround:

```typescript
dynamicPoolManager.registerPool(
  "imap",
  this.config.pools.imap as unknown as DynamicPoolConfig,
);
```

**Root cause:** `ConnectionPoolConfig` and `DynamicPoolConfig` have incompatible interfaces.

**Fix:** If keeping DynamicPoolManager, unify the config types. If removing it (Priority 1), this issue disappears.

---

## Lower Priority Items

### Timeout Protection Inconsistency

- IMAP pool has 5-second timeout protection
- SMTP and CalDAV operations have none

**Recommendation:** Add consistent timeout wrappers to all pool operations.

### Cache Key Fragility

Cache keys use `JSON.stringify(options)` which is order-dependent. Cache invalidation uses string matching on JSON fragments.

**Recommendation:** Create a deterministic `CacheKey` builder that sorts object keys before serialization.

### Search Query Builder Complexity

8 methods for query type checking and handling:
- `isOrQuery()` / `handleOrQuery()`
- `isFromQuery()` / `handleFromQuery()`
- etc.

**Recommendation:** Use a strategy pattern or simple map of handlers to reduce method sprawl.

---

## Implementation Order

1. **Remove DynamicPoolManager** (1 hour) - Immediate simplification, removes dead code
2. **Extract cache fallback pattern** (2-3 hours) - High impact on maintainability
3. **Consolidate address parsing** (30 min) - Quick win
4. **Add withConnection helper** (1 hour) - Reduces repetition
5. **Split EmailService** (4-6 hours) - Larger refactor, do when touching the file anyway

---

## What NOT to Change

- **ConnectionPool base class** - Well designed, handles edge cases properly
- **Error type hierarchy** - Comprehensive and useful
- **Service constructor injection** - Clean pattern, keep it
- **Test structure** - Good coverage, well organized

---

## Summary

The codebase is well-structured overall. The main issues are:

1. **Dead feature** (DynamicPoolManager) adding complexity
2. **Repeated patterns** that should be extracted
3. **One large file** (EmailService) that could be split

Addressing priorities 1-4 would remove ~400 lines of duplicate/dead code while improving consistency. Priority 5 (splitting EmailService) is a larger effort best done incrementally.
