# Models Benchmark Technical Specification

## 1. Purpose

Build a versioned pipeline for comparing coding models and agent runtimes on
the same software-maintenance tasks. Results must distinguish code quality from
provider availability, execution failure, timeout, and evaluator failure.

## 2. Non-goals

- A generic leaderboard for language understanding.
- Measuring raw token or API cost before a reliable usage source exists.
- Allowing candidates to inspect hidden tests, reference patches, or scoring
  implementation.
- Ranking models from a single task or a single provider outage.

## 3. Core Concepts

- **Benchmark release**: immutable version containing task fixtures, prompts,
  rubric, runner, evaluator contract, and model manifest.
- **Task**: a versioned repository state plus public instructions and a hidden
  evaluation contract.
- **Run**: one candidate execution on one task in one isolated workspace.
- **Candidate**: model, runtime, provider, and invocation configuration.
- **Harness**: adapter that starts a candidate and streams normalized events.
- **Evaluator**: independent process that tests the resulting workspace and
  checks forbidden changes.
- **Artifact**: structured metadata, patch, logs, test output, and evaluator
  result produced by a run.

## 4. Pipeline

1. Resolve an immutable benchmark release and model manifest.
2. Prepare a clean detached worktree from the task baseline.
3. Validate the candidate configuration and create a run ID.
4. Start the candidate through a runtime-specific harness.
5. Enforce timeout, output limits, process-group cleanup, and cancellation.
6. Freeze the workspace after the candidate exits.
7. Run public and hidden evaluators in separate environments.
8. Check allowed paths, patch size, and forbidden modifications.
9. Persist a schema-versioned artifact and classify the outcome.
10. Aggregate only comparable runs into a report with confidence notes.

## 5. Isolation and Security

- Every run gets a disposable workspace and unique process group.
- Candidate processes cannot read hidden fixtures, evaluator code, reference
  solutions, provider credentials, or other runs.
- Network access is denied by default and explicitly documented per harness.
- File writes are limited to the candidate workspace.
- Timeouts terminate the complete process group and are recorded as outcomes,
  not silently converted to failures of code quality.
- Logs are scrubbed for tokens and credentials before persistence.
- The evaluator runs after candidate teardown, with a separate environment and
  read-only access to benchmark metadata where possible.

## 6. Canonical Run Result

Each run must produce JSON containing at least:

```json
{
  "schema_version": 1,
  "run_id": "run_...",
  "benchmark_version": "v...",
  "task_id": "...",
  "candidate": {
    "model": "...",
    "runtime": "...",
    "provider": "..."
  },
  "status": "passed",
  "execution": {
    "started_at": "...",
    "completed_at": "...",
    "duration_ms": 0,
    "exit_code": 0,
    "timeout": false
  },
  "evaluation": {
    "public": {"passed": 0, "total": 0},
    "hidden": {"passed": 0, "total": 0},
    "forbidden_changes": 0,
    "rubric": {}
  },
  "artifacts": {
    "patch": "candidate.diff",
    "logs": []
  }
}
```

Provider, infrastructure, evaluator, and candidate outcomes must remain
machine-distinguishable. Missing evidence is not a zero-quality score.

## 7. Evaluation Model

The first release should report separate dimensions:

- public correctness;
- hidden correctness;
- regression safety;
- scope and forbidden-change compliance;
- code-quality rubric with anchored criteria;
- latency and timeout rate;
- provider/infrastructure availability.

An aggregate score is optional and must show its formula, denominator, excluded
runs, and uncertainty. A model with unavailable runs must not silently outrank
or fail against a model with complete evidence.

## 8. Reproducibility

Each report records source commit, benchmark version, task hash, prompt hash,
runner version, evaluator version, runtime version, model ID, relevant feature
flags, host class, and timestamps. Re-running a release must not mutate old
artifacts. Any rerun or replacement must have a new run ID and an explicit
relationship to the original.

## 9. Interfaces

The initial implementation should provide:

- a CLI to validate manifests and run one task or a matrix;
- a local evaluator command;
- a schema validator for run artifacts;
- an aggregation command that emits JSON, CSV, and Markdown;
- a report generator that links every score to evidence.

Provider adapters must be replaceable. The benchmark core must not depend on a
single gateway, model vendor, or UI.

## 10. Release Gate

A benchmark release is publishable only when:

- the runner passes its own tests;
- the fixture baseline and reference solution are verified;
- isolation checks pass;
- artifact schemas validate;
- a complete pilot matrix has no unexplained missing artifacts;
- provider failures are classified separately;
- the report is reproducible from the tagged source revision.

## 11. Open Decisions

Before implementation, decide task count and domains, candidate matrix,
network policy, evaluator isolation technology, rubric calibration, retry
policy, cost accounting, report hosting, and whether human review is required
for code-quality scores.
