# Clarity link preview export

`@oxyhq/api` provides a read-only, one-shot exporter for the final Clarity
cutover. It selects only resolved previews, excludes server-only origin asset
URLs, sorts rows by legacy ID and creates a versioned NDJSON file with a count
and SHA-256 attestation.

```bash
DATABASE_URL=postgresql://... bun run --filter @oxyhq/api export:clarity-link-previews -- ./oxy-link-previews.ndjson
```

The command refuses to overwrite an existing file. It does not update or delete
Oxy rows. Transfer the file through an approved encrypted channel, import it
with Clarity's one-shot importer, reconcile the reported counts, and retain it
until the post-cutover resolve checks succeed.
