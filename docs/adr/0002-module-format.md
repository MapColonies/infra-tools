# Module format: CommonJS by default, ESM only in the CLI

The repo defaults to CommonJS — `"module": "NodeNext"` inherited from `@map-colonies/tsconfig`, with no `"type": "module"` set — because this matches sibling repos and, more importantly, is a hard requirement of the VS Code extension host, which only loads CommonJS. `apps/cli` is the sole exception, running as ESM (`"type": "module"`), because the CLI ecosystem is ESM-first and benefits from top-level await and ESM-only libraries.

## The `packages/*` invariant

`packages/*` is always CommonJS, forever, even though `apps/cli` is ESM. This is a one-directional constraint, not a stylistic default: a CommonJS package can be `require()`d or imported from both an ESM consumer (`apps/cli`) and a CJS consumer (`apps/vscode`), but the reverse doesn't hold. Node's `require(esm)` support throws `ERR_REQUIRE_ASYNC_MODULE` the moment the required module's graph contains top-level await. An ESM shared package would work fine when imported from the CLI, and then break — not at build time, but at runtime, only inside the extension host, only if some transitive dependency happens to use top-level await — the moment the extension tried to consume it. Keeping `packages/*` as CommonJS closes off that failure mode entirely rather than relying on every future package author to avoid top-level await by discipline.

## Accepted costs in `apps/cli`

Running `apps/cli` as ESM while the rest of the repo is CommonJS carries two costs, accepted deliberately:

- Relative imports need explicit `.js` extensions — ESM resolution requires it, `tsc` doesn't add it for you, and this differs from the extension-context conventions elsewhere in the repo.
- `__dirname` and `require` aren't available; code in `apps/cli` uses `import.meta.dirname` instead.
