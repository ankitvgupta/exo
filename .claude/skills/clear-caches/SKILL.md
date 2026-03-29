---
name: clear-caches
description: Clear extension caches, analysis data, and drafts from the database. Use when testing sender lookups, analysis, or draft generation from a clean state.
disable-model-invocation: true
---

Clears all extension caches, analysis data, and draft data from the database. Use this when testing sender lookups, analysis, or draft generation from a clean state.

## What Gets Cleared

| Table | Description |
|-------|-------------|
| `extension_enrichments` | Cached enrichment results (sender profiles in sidebar) |
| `extension_storage` | Extension key-value storage (includes `profile:*` web search cache) |
| `sender_profiles` | Legacy sender profile cache |
| `analyses` | Email analysis results (needs_reply, priority) |
| `drafts` | Generated draft replies |

## Command

```bash
sqlite3 ~/Library/Application\ Support/exo/data/exo.db "
DELETE FROM extension_enrichments;
DELETE FROM extension_storage;
DELETE FROM sender_profiles;
DELETE FROM analyses;
DELETE FROM drafts;
SELECT 'Cleared:',
  (SELECT COUNT(*) FROM extension_enrichments) as enrichments,
  (SELECT COUNT(*) FROM extension_storage) as storage,
  (SELECT COUNT(*) FROM sender_profiles) as profiles,
  (SELECT COUNT(*) FROM analyses) as analyses,
  (SELECT COUNT(*) FROM drafts) as drafts;
"
```

## After Clearing

1. Restart the app to trigger re-analysis and re-enrichment
2. The prefetch queue will process all inbox emails again
3. Watch logs for `[Prefetch]`, `[Ext:web-search]`, `[Ext:calendar]` activity

## Partial Clears

To clear only specific caches:

```bash
# Clear only sender profile data (keeps analyses and drafts)
sqlite3 ~/Library/Application\ Support/exo/data/exo.db "
DELETE FROM extension_enrichments;
DELETE FROM extension_storage WHERE key LIKE 'profile:%';
DELETE FROM sender_profiles;
"

# Clear only analyses (will re-analyze all emails)
sqlite3 ~/Library/Application\ Support/exo/data/exo.db "DELETE FROM analyses;"

# Clear only drafts
sqlite3 ~/Library/Application\ Support/exo/data/exo.db "DELETE FROM drafts;"
```
