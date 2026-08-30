# Monorepo layout and toolchain

This repo hosts two independent workspaces — a CLI and a VS Code extension — with no shared library yet, and nothing in either workspace is ever published. We chose pnpm workspaces with two globs (`apps/*`, `packages/*`) and Turborepo for task orchestration, because that combination gives us incremental, cached builds across workspaces without paying for tooling aimed at published-package concerns we don't have.

## Decision

- **Workspace structure:** pnpm workspaces with two globs, `apps/*` and `packages/*`. Today `apps/*` holds two workspaces, `cli` and `vscode`. `packages/*` is empty and stays empty until a second consumer actually needs shared logic — we don't pre-create placeholder packages.
- **Task orchestration:** Turborepo, with every task's `dependsOn` set to `["^build"]` — upstream workspace builds only, never a workspace's own build. This is a deliberate resolution of a contradiction we found between sibling repos `jobnik` and `opa-la`, which disagree on this point; here, a workspace never lists itself as its own build dependency. Turbo's UI is streamed, and task logs are configured to surface on error only, to keep a green run quiet.
- **Build:** `tsc` is the compiler everywhere. `esbuild` bundling is used only in `apps/vscode`, because it's the tool the VS Code marketplace's own bundling guide documents. Rolldown was evaluated for `apps/vscode` and rejected — there's no webview UI in the extension today that would benefit from it; the decision is revisited if one is added.
- **Nothing publishes:** every workspace is `private`, there is no npm registry target and no VS Code Marketplace listing. `release-please` is retained, but only for its tagging and changelog generation — versioning is independent per workspace (no linked-versions), since there's no published artifact to keep in lockstep.

## Deliberately excluded

These tools solve problems that only exist for published packages, and this repo publishes nothing:

- **`publint`** — lints a package's `package.json`/exports shape for consumers installing it off a registry. No registry target here.
- **`@arethetypeswrong/cli`** — checks that a published package's type declarations resolve correctly for downstream consumers. Nothing is published.
- **`check-pack`** — verifies the contents of a package tarball before publish. There's no tarball.
- **`typedoc`** — generates reference documentation for a public API surface. Neither workspace exposes one.
- **Docker / Helm** — this repo produces a CLI binary and an editor extension, not a deployable service.
- **`redocly` / OpenAPI linting** — no HTTP API is defined anywhere in this repo.
- **An e2e workspace** — end-to-end suites here would be specific to a downstream service's runtime environment, which this repo doesn't have.

If any of these concerns become real (e.g. a workspace starts publishing, or a service is added), revisit this list rather than silently reintroducing the tool without a reason recorded here.
