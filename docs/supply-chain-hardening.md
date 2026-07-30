# Dependency supply-chain hardening

This document explains a proposed change to how this repository installs its npm dependencies,
and why. It describes two options: a configuration-only change that keeps npm (implemented on
the `supply-chain/npm-hardening` branch), and a migration to pnpm 11 (implemented on the
`supply-chain/pnpm-migration` branch). They are independent — neither depends on the other.

## The gap today

This repository is already in better shape than most. Worth stating up front, because the
proposal below is narrow on purpose:

- All GitHub Actions are pinned by commit SHA, not by tag.
- `ci.yml` declares `permissions: contents: read` at the top level.
- CodeQL analysis and OSSF Scorecard both run.
- Dependabot is configured for npm and github-actions, daily, with sensible groupings.

Against that, one gap stands out:

| Gap | Where |
| --- | --- |
| CI installs with `npm install`, not `npm ci` | `.github/workflows/ci.yml:25`, `.github/workflows/update-snapshot.yml:46` |
| No `.npmrc`, so every install-time default is npm's default | repository root |
| No quarantine on freshly published versions | — |
| Dependency changes are reviewed as lockfile diffs, with no vulnerability surfacing in the PR | no `dependency-review-action` in any workflow |

`npm install` is the important one. It is allowed to re-resolve the dependency graph and rewrite
`package-lock.json`, which means a CI run can install a version that nobody reviewed and that is
not the version the lockfile pins. `npm ci` installs exactly the lockfile, fails if
`package.json` and the lockfile disagree, and never writes the lockfile. Switching is a one-word
change with no downside for this repository, since the lockfile is committed.

## Why a release-age quarantine is the highest-value addition

The npm compromises that mattered recently were not subtle long games. They were loud, and they
were caught quickly:

| Incident | Time to detection / removal |
| --- | --- |
| `debug` / `chalk` (September 2025) | ~2.5 hours |
| Shai-Hulud | ~12 hours |
| TanStack — 84 malicious versions across 42 `@tanstack/*` packages (11 May 2026) | published within a 6-minute window |

In each case, a consumer who simply refused to install anything published in the last 24 hours
would never have been exposed. That is the entire idea behind a release-age quarantine: it costs
one day of latency on new versions and requires trusting nothing new.

One correction to a common assumption is worth recording here. **Provenance attestations would
not have stopped the TanStack compromise.** That wave was the first to obtain *valid* SLSA
provenance on malicious packages — the attacker extracted an OIDC token from the GitHub Actions
runner, so the packages were genuinely signed by the real pipeline. Signature verification
confirms *where* a package was built, not that it is safe. A time window does not have that
weakness.

## Option A — stay on npm (configuration only)

Branch: `supply-chain/npm-hardening`.

| Change | Effect |
| --- | --- |
| `npm install` → `npm ci` in both workflows | CI installs exactly the reviewed lockfile, or fails |
| `min-release-age=1` in `.npmrc` | Versions published less than a day ago are not resolved |
| `engine-strict=true` + `engines.npm >= 11.10.0` | Turns an old-npm silent no-op into a hard failure |
| Explicit `npm install -g npm@^11.16.0` step in CI | Guarantees the runner's npm actually supports the above |
| `allowScripts` in `package.json` | Records which dependencies are permitted to run install scripts |
| `dependency-review-action` job on pull requests | New dependencies and known vulnerabilities appear in the PR |

Two details in that table are less obvious than they look.

**The npm version pin is not busywork.** `.nvmrc` pins only the Node major (`24`), and the npm
bundled with Node 24 varies by patch release: Node 24.11.1 ships npm 11.6.2, Node 24.16.0 ships
11.13.0, Node 24.18.0 ships 11.16.0. `min-release-age` requires npm ≥ 11.10.0 and is **silently
ignored** by anything older. Without the pin, whether the quarantine is real depends on which
Node patch the runner happens to resolve that week.

**`allowScripts`, not `ignore-scripts`.** The obvious way to stop malicious `postinstall` scripts
is `ignore-scripts=true`, and it would break this repository. With `ignore-scripts` set, npm does
not run pre/post scripts around `npm run`, so `npm run build` would stop triggering the
`postbuild` hook that executes `scripts/build-search-index.mjs`, and production builds would ship
without a search index — silently. `allowScripts` is the correct mechanism: it applies to
*dependencies'* install scripts only and leaves the project's own scripts alone.

The eight entries in `allowScripts` are every dependency in the current lockfile flagged
`hasInstallScript`, all of them native-binary packages that legitimately need a build step:
`@parcel/watcher`, `@swc/core`, `esbuild` (two versions), `fsevents`, `sharp`, `unrs-resolver`,
`workerd`.

This option is also forward-looking rather than divergent. npm 12 (estimated July 2026) makes
dependency install scripts **off by default**, and changes `--allow-git` and `--allow-remote` to
default to `none`. Adopting `allowScripts` now means the eventual npm 12 upgrade is uneventful.

## Option B — migrate to pnpm 11

Branch: `supply-chain/pnpm-migration`.

pnpm 11 ships supply-chain defaults that npm still leaves opt-in:

| Setting | pnpm 11 default | What it does |
| --- | --- | --- |
| `minimumReleaseAge` | `1440` (minutes = 1 day), **on by default** | Same quarantine as Option A, without configuration |
| `blockExoticSubdeps` | `true`, **on by default** | Transitive dependencies may not resolve from git repos or tarball URLs; only direct dependencies may |
| `trustPolicy` | `off` — **opt-in** | Set to `no-downgrade`, fails if a package's trust level dropped versus earlier releases |
| `dangerouslyAllowAllBuilds` | `false` | Dependency build scripts require explicit approval via `allowBuilds` |

Only `trustPolicy` requires a deliberate decision; everything else in that table is already how
pnpm 11 behaves out of the box.

### Enabling trustPolicy found something immediately

This is not hypothetical. Turning on `trustPolicy: no-downgrade` and installing this repository's
current dependency tree fails:

```
[ERR_PNPM_TRUST_DOWNGRADE] High-risk trust downgrade for
"eslint-import-resolver-typescript@3.10.1" (possible package takeover)

This error happened while installing the dependencies of eslint-config-next@16.2.12

Earlier versions had provenance attestation, but this version has no trust evidence.
```

That is a real transitive dependency of `eslint-config-next` which used to publish with a
provenance attestation and now publishes with none. The most likely explanation is a release
pipeline that stopped attesting, not a takeover — but the point is that nothing in the current
setup would ever have surfaced it.

Excluding that one is not the end of it. The next install failed on `semver@6.3.1`, reached via
`eslint-config-next` → `eslint-plugin-react`. That class of hit is noise: long-dormant transitive
packages whose last release predates provenance being common. Excluding them one at a time would
turn the config into an unmaintainable allowlist, so the branch sets
`trustPolicyIgnoreAfter: 525600` (one year) to scope the check to packages that were attested
recently enough for a downgrade to mean something.

`eslint-import-resolver-typescript@3.10.1` stays in `trustPolicyExclude` as the one hit recent
enough to deserve a human decision. That entry is a placeholder for a decision, not a conclusion:
someone should confirm why provenance disappeared and remove the exclusion once it returns.

**Honest read:** `trustPolicy: no-downgrade` is the one setting here that carries ongoing
maintenance cost. It works, and it found something real, but adopting it means someone owns the
resulting triage. It is also the only setting in the table that is opt-in, so Option B remains a
clear improvement even with `trustPolicy` left off entirely.

pnpm's strict `node_modules` layout also structurally prevents phantom dependencies — importing a
package that a transitive dependency happened to hoist into place, without declaring it. That
removes a class of undeclared, unreviewed, and therefore unpinned dependency.

### Costs, stated plainly

- **Two deployment paths, only one of them fully in the repository.** `netlify.toml` is committed
  and its `command` is updated to `pnpm run build` on the branch; Netlify infers the package
  manager from the committed lockfile, so replacing `package-lock.json` with `pnpm-lock.yaml` is
  the switch it reacts to. The Cloudflare path is the gap: `cf:build`, `preview`, and `deploy` use
  `opennextjs-cloudflare` and `wrangler`, but whatever install command drives that deployment is
  configured outside the tree. A maintainer with dashboard access needs to confirm it before this
  branch is mergeable — it can break in a way no diff will show.
- **`overrides` must move into `pnpm-workspace.yaml`, not into a `pnpm` field in
  `package.json`.** The npm-specific top-level `overrides` field is ignored by pnpm, and pnpm 11
  no longer reads the `pnpm` field in `package.json` either — it warns `The "pnpm" field in
  package.json is no longer read by pnpm` and carries on. Both wrong placements silently drop the
  `typescript@^6.0.0` pin for `openapi-typescript` while appearing to have configured it. The
  correct home is a top-level `overrides:` key in `pnpm-workspace.yaml`, using pnpm's
  `parent>child` selector syntax.
- **Strict resolution can surface pre-existing phantom dependencies.** That is the feature working
  as intended, but it means the migration may require adding genuinely missing declarations to
  `package.json`.
- **The build allowlist is `allowBuilds`, not `onlyBuiltDependencies`.** pnpm 11 reads the former
  and silently ignores the latter, then fails the install with `ERR_PNPM_IGNORED_BUILDS` listing
  the packages whose scripts it skipped. The stale name is still widely cited, so this is easy to
  get wrong in a way that looks configured but is not.
- **pnpm does not inherit the versions npm had resolved.** Generating `pnpm-lock.yaml` re-resolves
  the graph from the ranges in `package.json`, so some packages land on different versions than
  `package-lock.json` pinned (`@parcel/watcher` 2.5.1 → 2.6.0, `@swc/core` 1.15.2 → 1.15.46,
  `unrs-resolver` 1.11.1 → 1.12.2 in this migration). Nothing is wrong with those versions, but
  the migration commit is a dependency bump as well as a tooling change, and should be reviewed
  as both.
- Contributor instructions, `.gitattributes`, and the `cache:` setting in both workflows all need
  updating together.
- **The agentic workflows still tell their agent to run `npm install`.**
  `.github/workflows/modernize-apply.md` instructs the agent to verify changes with `npm install`
  / `npm run lint` / `npm test` / `npm run build`, and `modernize-audit.md` tells it to read
  `package-lock.json`. Those `.md` files are compiled into the matching `*.lock.yml` by
  `gh aw compile`, and `.gitattributes` plus `dependabot.yml` both mark the compiled output as
  compiler-owned. The `supply-chain/pnpm-migration` branch deliberately leaves them untouched,
  because editing the source without regenerating the compiled workflow would ship a
  source/artifact mismatch. A maintainer with `gh aw` needs to update and recompile them as part
  of accepting Option B.

## What neither option fixes

The TanStack compromise did not enter through the package manager. The vector was GitHub Actions:
a `pull_request_target` "pwn request", cache poisoning across the fork/base trust boundary, and
extraction of an OIDC token from the runner process. No npm credentials were stolen and no
maintainer account was phished.

Choosing a package manager does nothing about that class of attack. In this repository the only
workflow using `pull_request_target` is `.github/workflows/dependabot-auto-merge.yml`. Reviewing
it is out of scope here and is best treated as a separate discussion, but it is the logical next
thread to pull.

## Recommendation

Option A is a small, reviewable, low-risk change that closes the `npm install` gap and adds a
quarantine that would have blocked every recent incident listed above. Option B is strictly
stronger on defaults but carries a real, unresolved question about the Cloudflare deployment.

Taking Option A now does not foreclose Option B later; the two branches were built independently
from `main` for exactly that reason.

## References

- npm config: <https://docs.npmjs.com/cli/v11/using-npm/config/>
- npm scripts (`ignore-scripts` and pre/post behaviour): <https://docs.npmjs.com/cli/v11/using-npm/scripts/>
- `npm approve-scripts`: <https://docs.npmjs.com/cli/v11/commands/npm-approve-scripts/>
- npm v12 default changes: <https://github.com/orgs/community/discussions/198547>
- pnpm settings: <https://pnpm.io/settings>
- TanStack compromise postmortem: <https://tanstack.com/blog/npm-supply-chain-compromise-postmortem>
