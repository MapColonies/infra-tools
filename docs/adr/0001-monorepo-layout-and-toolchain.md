# Monorepo layout and toolchain

This repo hosts two independent workspaces — a CLI and a VS Code extension — with no shared library yet, and nothing in either workspace is ever published. We chose pnpm workspaces with two globs (`apps/*`, `packages/*`) and Turborepo for task orchestration, because that combination gives us incremental, cached builds across workspaces without paying for tooling aimed at published-package concerns we don't have.

## Decision

- **Workspace structure:** pnpm workspaces with two globs, `apps/*` and `packages/*`. Today `apps/*` holds two workspaces, `cli` and `vscode`. `packages/*` stays empty until a package is justified — see "Amendment: the `packages/*` extraction criterion" below for what justifies one.
- **Task orchestration:** Turborepo, with `dependsOn` set to `["^build"]` on `build`, `lint`, `type-check`, and `test` — upstream workspace builds only, never a workspace's own build. This is a deliberate resolution of a contradiction we found between sibling repos `jobnik` and `opa-la`, which disagree on this point; here, a workspace never lists itself as its own build dependency for those tasks. `package` is the one exception, with `dependsOn: ["^build", "build"]`, since packaging a workspace needs its own build output to exist first. Turbo's UI is streamed, and task logs are configured to surface on error only, to keep a green run quiet.
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

## Amendment: the `packages/*` extraction criterion

The original wording of the workspace-structure decision said `packages/*` "is empty and stays empty until a second consumer actually needs shared logic — we don't pre-create placeholder packages." That rule conflated two different things: pre-creating an empty package with no logic in it yet, and extracting logic that already exists and already has a reason to live on its own. Only the first is what the rule was meant to prevent.

The registry-verification work (#17) extracts two packages — the Helm package, which knows what a Helm chart is (locating image references in values file source and resolving which chart's metadata governs a given values file) and never imports `vscode` or performs I/O directly, and the OCI registry package, which knows what a container registry is (reference normalization, credential resolution, manifest existence checks) and knows nothing about Helm, YAML, or editors — while the VS Code extension remains their only consumer. The CLI that would be a second consumer is anticipated, not built yet. Under the original wording that reads as forbidden.

The extraction is justified anyway, on two grounds that have nothing to do with consumer count:

- **Domain independence.** Each package is a substantial, self-contained body of logic — credential chains, token exchange, protocol handling for the registry package; chart-metadata resolution for the Helm package — with nothing to do with Helm/editors or with each other. Neither is a stub waiting for a future purpose; both already have one.
- **Testability.** `apps/vscode`'s own test configuration already argues this seam independently of any second consumer: logic that never imports the `vscode` API belongs in a package where it needs no mocking, rather than behind the extension's checked-in `vscode` stub.

The rule is revised accordingly: extraction into `packages/*` is justified by domain independence and testability, not gated on a second consumer existing yet. What the original rule protected against — an empty package created on spec, with no logic and no test seam behind it, added because it might be useful someday — still stands and is still forbidden. A package must ship with real logic from the commit that creates it.
