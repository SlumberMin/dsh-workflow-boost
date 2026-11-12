# CI templates

These workflow files are kept outside `.github/workflows/` so the repository can be
pushed with a token that lacks the GitHub `workflow` OAuth scope.

To enable them:

1. `gh auth refresh -s workflow` (or add the files through the GitHub web UI), then
2. copy `ci/ci.yml` and `ci/release.yml` into `.github/workflows/`, commit and push.

- `ci.yml` runs `node test/check.mjs`, `node test/unit.mjs` and `node test/verify-harness.mjs` on push/PR.
- `release.yml` runs the same checks, runs `npm pack`, and attaches the tarball + SHA256SUMS to a GitHub Release on `v*` tags.
