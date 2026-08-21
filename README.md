# Models Benchmark

Private research repository for a reproducible, auditable benchmark of coding
models and agent runtimes.

The project is being redesigned from the original `models-test` experiment into
a professional benchmark pipeline. The goal is to measure not only whether a
model produces a passing patch, but also correctness, regression safety,
scope discipline, reproducibility, latency, and operational failures.

## Current Status

This repository currently contains the design baseline only. The benchmark
runner, evaluator service, storage format, and first production benchmark have
not been implemented yet.

## Design Goals

- identical tasks, prompts, and starting revisions for every candidate;
- isolated execution with no cross-run state or access to private orchestration;
- deterministic, machine-readable artifacts;
- separate model quality from provider availability and infrastructure errors;
- reproducible local runs and independently verifiable published reports;
- explicit versioning of tasks, rubrics, harnesses, models, and runner code.

## Documentation

- [Technical specification](docs/technical-spec.md)
- [Roadmap](docs/roadmap.md)

The specification is intentionally open for review before implementation.

## How The Pilot Works

Codex acts as the visible orchestrator. It reads the private runner
configuration, starts the pilot, reports live progress, and stops on an
unexpected failure. Candidate models are executed one at a time in the clean
room through their configured OpenCode or Codex agent.

```mermaid
flowchart TD
    A[User gives Codex the benchmark command] --> B[Private models-benchmark runner]
    B --> C[Reset clean-room account as candidate user]
    C --> D[Restore public feature-implementation task]
    D --> E[Start a new OpenCode or Codex session]
    E --> F[Candidate model works once]
    F --> G[Run public tests and collect diff]
    G --> H[Save raw output in runner HOME]
    H --> I[Write sanitized artifacts to models-test checkout]
    I --> J[Manual review and publication]
    J --> K[Reset room before next candidate]
    K --> C
```

The first pilot uses one public task and three models already present in the
published comparison. Each model receives one pass and one chance. There is
no retry and no reuse of a previous agent session.

## Repository Boundaries

`models-benchmark` is private and contains the runner, manifests, reset
orchestration, judge configuration, and private raw artifacts. The task itself
and its public tests remain available in `models-test`.

The candidate account can read the published task and tests, but cannot read
runner-owned raw logs, judge prompts, reference solutions, credentials, or
other candidates' results. The runner writes only sanitized result files to
the `models-test` checkout. It never pushes them automatically.

## Pilot Commands

From the repository root, inspect the planned matrix first:

```sh
npm run pilot:dry-run
```

The real pilot is intentionally explicit:

```sh
npm run pilot
```

Progress is emitted as newline-delimited JSON. Results are prepared under the
configured `models-test` checkout for manual inspection and publication.

## Result Layout

For each candidate and task, the public results directory contains:

```text
run.json
candidate.diff
test-result.json
```

`run.json` records the benchmark release, task, agent, runtime, model,
subscription, execution status, changed files, and artifact locations. Raw
agent stdout/stderr remains under the private runner artifact directory.

## Security Boundary

Candidate models run against disposable workspaces with least-privilege
credentials. Tasks and public tests are intentionally available to the
candidate. Reference solutions, judge prompts, scoring data, secrets, provider
tokens, and private repository contents must never be available to the
candidate process or published in the public results repository.
