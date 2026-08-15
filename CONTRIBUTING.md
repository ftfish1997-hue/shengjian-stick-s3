# Contributing

Contributions are welcome when they keep the project self-hostable and protect voice data by default.

## Before a pull request

1. Work from a focused branch.
2. Add or update tests for behavior changes and verify the test fails before the implementation.
3. Use synthetic devices, recordings, transcripts, and identifiers only.
4. Do not commit `.env` files, credentials, audio, database dumps, Flash/NVS exports, private hosting metadata, or signed URLs.
5. Run:

   ```bash
   make test
   make validate-json
   make public-audit
   cd dashboard && npm ci && npm run lint && npm test
   ```

6. Describe hardware-only validation separately; never attach personal audio.

Please keep pull requests small and explain any database migration or privacy impact.
