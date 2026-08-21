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

## 2.1 First Benchmark Shape

The first benchmark release is intentionally close to normal use of a coding
agent rather than a collection of isolated micro-prompts:

- six tasks are run sequentially for each candidate model;
- the initial six-task set is taken from the maintained `models-test` task
  suite (the ledger task plus the five Phase 2 tasks);
- each task includes the documentation and local context needed to solve it;
- the candidate receives one pass and one chance per task; retries are not
  allowed;
- the candidate is configured in OpenCode and runs as a normal agent would;
- task results are preserved before any judging begins.

The benchmark must measure practical end-to-end work, not only the ability to
solve a small isolated function.

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
- **Clean room**: a dedicated Linux account and workspace used for exactly one
  candidate run. It is reset completely before the next candidate.
- **Judge**: an independent model that reviews the resulting code and evidence
  against the published criteria.

## 3.1 Candidate and Judge Manifests

Candidates and judges are data, not hard-coded runner logic. The first version
should use a versioned manifest such as:

```json
{
  "candidates": [
    {"id": "opencode-go/example-free", "runtime": "opencode", "model": "..."}
  ],
  "judges": [
    {"id": "chatgpt", "provider": "openai", "model": "..."},
    {"id": "gemini", "provider": "google", "model": "..."}
  ]
}
```

Claude is intentionally excluded from the initial judge matrix. The manifest
must record model IDs and provider configuration without storing credentials.

## 4. Pipeline

1. Resolve an immutable benchmark release, candidate manifest, and judge
   manifest.
2. Provision or reset the dedicated clean-room Linux account.
3. Prepare the six task workspaces and task documentation in that account.
4. Validate the candidate configuration and create a run ID.
5. Start the candidate through OpenCode and execute the six tasks sequentially.
6. Enforce timeout, output limits, process-group cleanup, and cancellation.
7. Freeze the complete six-task result before judging.
8. Run public and hidden evaluators in separate environments.
9. Send the resulting code and evidence to each configured judge independently.
10. Record every judge response and score; do not ask a judge to reconcile
    another judge's score.
11. Check allowed paths, patch size, and forbidden modifications.
12. Persist schema-versioned artifacts and classify every outcome.
13. Reset the clean room completely before the next candidate.
14. Aggregate only comparable runs into a report with confidence notes.

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

Each judge scores the resulting code independently on the same three or four
criteria. The initial rubric should use four criteria:

- functional correctness;
- reliability and edge-case handling;
- maintainability and clarity;
- scope discipline and fit to the task.

The first release should report separate dimensions:

- public correctness;
- hidden correctness;
- regression safety;
- scope and forbidden-change compliance;
- code-quality rubric with anchored criteria;
- latency and timeout rate;
- provider/infrastructure availability.

Judge scores, explanations, model ID, prompt version, and timestamp are logged
as immutable artifacts. The aggregate must show each judge separately before
calculating any mean or consensus score. A judge failure is missing evidence,
not an automatic zero.

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

Before implementation, decide the exact six task revisions, candidate model
list, judge model IDs, clean-room reset mechanism, network policy, evaluator
isolation technology, rubric calibration, cost accounting, report hosting, and
whether a human review is required for disputes. Retry policy is fixed for the
first release: one pass and one chance, with no candidate retry.
