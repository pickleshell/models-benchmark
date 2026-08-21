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
uses one public `feature-implementation` task and the three candidates in
`config/pilot.json`. It runs candidates sequentially and starts a new agent
session for every candidate.

The runner resets the clean-room workspace and isolated agent home by invoking
`/home/test/.models-benchmark/reset-room.mjs` as the candidate account `test`
before each run. Raw model output is written under the private artifact
directory; only sanitized `run.json`, `candidate.diff`, and test results are
written to `models-test`.

Never push or publish results automatically. Inspect the generated public
artifacts and use a separate manual review before committing to `models-test`.

Preserve timing data in sanitized artifacts: `started_at`, `completed_at`, and
`duration_ms` are required for new candidate, test, and judge results. Do not
attempt to reconstruct missing timing for older releases.

Candidate commands, public tests, judges, and Git inspection of candidate
workspaces run through the required transient `systemd-run` sandbox. Do not
replace it with direct `sudo -u test` execution. The sandbox supplies private
`/tmp`, a read-only OpenCode runtime, and writable binds only for the selected
workspace and disposable agent home.

Treat `allowed_changes` as a release policy, not reporting metadata. A changed
path outside it is a `forbidden_changes` outcome and must never be judged or
aggregated as a completed candidate.

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
