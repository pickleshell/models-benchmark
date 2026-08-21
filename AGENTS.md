# Models Benchmark Contributor Guide

## Scope

This private repository contains the benchmark runner and orchestration. Public
tasks and public test results belong in `/home/gpt/models-test`.

## Required reading and deployment

For an installation or clean-room change, read `README.md`,
`docs/deployment.md`, `docs/technical-spec.md`, and `config/pilot.json` before
acting. The deployment guide is the operational source of truth; do not infer
accounts, paths, or privilege boundaries from another host.

The runner account is trusted and owns private raw artifacts. The clean-room
account executes candidates and judges but must have no sudo access and no
access to runner-owned artifacts, credentials, hidden data, or another run's
workspace. The runner resets the room before every candidate and once more at
the end of a completed matrix.

## Pilot workflow

Run `npm run pilot:dry-run` before any real model invocation. The pilot runner
uses the public tasks and three candidates in `config/pilot.json`. It runs
candidates sequentially and starts a new agent session for every candidate/task
pair.

The runner probes each configured model before assigning any task. A model is
available only after a harmless request produces a recognised model response;
a provider diagnostic or zero exit code alone is not evidence of availability.
An unavailable model receives `preflight.json` and `unavailable` task records,
then the runner proceeds to the next model without starting its task matrix.
Probe required judges before creating a release directory or assigning a
candidate task. If any judge is unavailable, stop with no release created.

The runner resets the clean-room workspace and isolated agent home by invoking
`/home/test/.models-benchmark/reset-room.mjs` as the candidate account `test`
before each run. Raw model output is written under the private artifact
directory; only sanitized availability records, `run.json`, `candidate.diff`,
and public test results are written to `models-test`.

Never push or publish results automatically. Inspect the generated public
artifacts and use a separate manual review before committing to `models-test`.

Preserve timing data in sanitized artifacts: `started_at`, `completed_at`, and
`duration_ms` are required for new candidate, test, and judge results. Do not
attempt to reconstruct missing timing for older releases.

Candidate commands, public tests, judges, and Git inspection of candidate
workspaces run through the required transient `systemd-run` sandbox. Do not
replace it with direct `sudo -u test` execution. Each sandbox is a fresh mount
namespace: model processes cannot see the host home, host temporary files,
another run's workspace, session history, or artifacts. They receive only the
selected disposable workspace, a fresh agent home, read-only OpenCode runtime,
and a private temporary filesystem that is destroyed with the sandbox.

Treat `allowed_changes` as a release policy, not reporting metadata. A changed
path outside it is a `forbidden_changes` outcome and must never be judged or
aggregated as a completed candidate.

Judging must remain identity-blind. Never add candidate ID, model, agent/runtime,
provider, subscription, candidate logs, private artifacts, or candidate-derived
paths, prompt text, environment values, or temporary names to judge inputs. Use
an explicit allowlist for safe execution evidence and an opaque random workspace
name. Rebuild each judge workspace from the trusted baseline plus the recorded
candidate patch; never copy candidate `.git` metadata and never give the judge
a writable bind for the original candidate workspace. Candidate association belongs only in runner-side artifacts after judging;
stylistic inference by a judge is an acknowledged residual risk.

Benchmark release directories are immutable. A real run must stop before any
work if either the private or sanitized public directory for its release ID
already exists. Use a new release ID for every rerun.

## Required checks

```sh
npm run pilot:dry-run
npm test
git diff --check
```

For a deployment or environment change, also verify the configured clean-room
user and its OpenCode CLI with the exact preflight commands in
`docs/deployment.md`. Do not invoke `npm run pilot` merely as a health check:
it spends provider quota and creates a benchmark run.

Do not place credentials, hidden evaluation data, judge prompts, or raw logs in
the public results repository.
