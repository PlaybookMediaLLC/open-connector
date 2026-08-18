# Fork development rules

This repo is a PlaybookMediaLLC fork of oomol-lab/open-connector. The fork adds
Lens, an agent authorization control plane. The isolation strategy lives in
`rfc/0004-fork-isolation.md`. Read it before you change code. Upstream
conventions live in `AGENTS.md`.

## Keep upstream merges cheap

1. Put all new runtime code in `src/lens/`. Put tests beside the modules.
2. Never add fork logic inline in upstream files. Mount fork code through a
   seam: one short line marked `// lens-seam`. Register every seam in the
   RFC 0004 seam table. Audit with `grep -rn "lens-seam" src/`.
3. Wrap upstream chokepoints. Do not modify them. `wrapActionRunner` is the
   main hook.
4. Use fork namespaces only: `lens_` tables, `LENS_*` env vars, routes under
   `/lens/*`. Never repurpose `OOMOL_CONNECT_*` variables.
5. New providers get their own `src/providers/<name>/` directory. Run
   `npm run fix-check` to regenerate the provider registry. Never hand-edit
   `registry.generated.ts` or `registry.cloudflare.generated.ts`.

## Upstream sync

`.github/workflows/sync-upstream.yml` merges upstream main into the `upstream`
branch every night and opens a PR against main.

Known conflict classes and their fixes:

- `assets/star-history/*`: both repos regenerate these daily. The workflow
  keeps the fork's versions automatically.
- `registry.*.generated.ts`: regenerate with `npm run fix-check`. Do not merge
  the file content by hand.
- Seam files (`connect-app.ts`, `index.ts`, `cloudflare.ts`): re-add the marked
  lines.
- A conflict anywhere else means a rule was broken. Fix the placement, not
  just the conflict.

## Checks

Run `npm run fix-check && npm test` before you call work complete. A dropped
seam fails the typecheck. A behavioral regression fails the `src/lens` tests.
