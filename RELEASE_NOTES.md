# Release v0.9.7-patch.1

Release date: 2025-10-13

Summary
- Patch release to address minor regressions and housekeeping after the alpha cycle. This does not introduce new public APIs.

Notable fixes
- Fix: Restore backwards-compatible behavior in configuration parsing that could break some deployments.
- Fix: Correct logging header to include request IDs for certain background jobs.
- Chore: Bump version and update release metadata.

Migration notes
- No database migrations required.

Contact
- If you see any issues after upgrading, please open an issue or contact the maintainers.
