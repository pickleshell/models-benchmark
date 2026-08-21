# Models Benchmark Contributor Guide

## Scope

This private repository contains the benchmark runner and orchestration. Public
tasks and public test results belong in `/home/gpt/models-test`.

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

## Required checks

```sh
npm run pilot:dry-run
git diff --check
```

Do not place credentials, hidden evaluation data, judge prompts, or raw logs in
the public results repository.
