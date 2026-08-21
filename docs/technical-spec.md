# Models Benchmark Technical Specification

## 1. Purpose

Build a versioned pipeline for comparing coding models and agent runtimes on
the same software-maintenance tasks. Results must distinguish code quality from
provider availability, execution failure, timeout, and evaluator failure.

## 2. Non-goals

- A generic leaderboard for language understanding.
- Measuring raw token or API cost before a reliable usage source exists.
- Requiring the benchmark pipeline itself to be public; task data and tests are
  public, while orchestration and judging implementation remain private.
- Ranking models from a single task or a single provider outage.

## 2.1 First Benchmark Shape

The benchmark is intentionally close to normal use of a coding agent rather
than a collection of isolated micro-prompts. Counts below are release
configuration, not architectural limits:

- a configurable number of tasks is run sequentially for each candidate;
- the pipeline-validation pilot uses the public `feature-implementation`
  task from `models-test`;
- the pilot candidate set contains any three models already represented in the
  published model comparison; the exact three are a manifest choice;
- after the pilot succeeds, the benchmark expands to two or three tasks and
  can grow further;
- each task includes the documentation and local context needed to solve it;
- the candidate receives one pass and one chance per task; retries are not
  allowed;
- candidates may use OpenCode or Codex, and every run records the selected
  agent/runtime explicitly;
- task results are preserved before any judging begins.

The benchmark must measure practical end-to-end work, not only the ability to
solve a small isolated function.

## 3. Core Concepts

- **Benchmark release**: immutable version containing task fixtures, prompts,
  rubric, runner, evaluator contract, and model manifest.
- **Task**: a versioned repository state, public instructions, documentation,
  and public tests.
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

## 3.1 Candidate, Task, Judge, and Rubric Manifests

Candidates, tasks, judges, and criteria are data, not hard-coded runner logic.
Their counts may change between benchmark releases. The runner must validate
and report the configured matrix rather than assume fixed cardinality. The
first version should use a versioned manifest such as:

```json
{
  "candidates": [
    {
      "id": "example-free",
      "agent": "opencode",
      "runtime": "opencode",
      "model": "...",
      "subscription": "free"
    }
  ],
  "tasks": ["phase1-ledger", "phase2-feature-implementation"],
  "judges": [
    {"id": "chatgpt", "provider": "openai", "model": "..."},
    {"id": "gemini", "provider": "google", "model": "..."}
  ],
  "criteria": [
    "functional_correctness",
    "reliability_edge_cases",
    "maintainability_clarity",
    "scope_discipline"
  ]
}
```

Claude is intentionally excluded from the current pilot judge matrix, not
from the architecture. The manifest must record model IDs and provider
configuration without storing credentials.

## 4. Pipeline

1. Resolve an immutable benchmark release, candidate manifest, and judge
   manifest.
2. Provision or reset the dedicated clean-room Linux account.
3. Prepare the configured task workspace and task documentation in that
   account. The pipeline pilot uses `feature-implementation`; later releases
   may configure more tasks.
4. Validate the candidate configuration and create a run ID.
5. Start the candidate through its configured agent (OpenCode or Codex) and
   execute the configured tasks sequentially.
6. Enforce timeout, output limits, process-group cleanup, and cancellation.
7. Freeze the complete configured result before judging.
8. Run the published tests and checks in a separate evaluator environment.
9. Send the resulting code and evidence to each configured judge independently
   for each configured criterion.
10. Record every judge response and score; do not ask a judge to reconcile
    another judge's score.
11. Check allowed paths, patch size, and forbidden modifications.
12. Persist schema-versioned artifacts and classify every outcome.
13. Reset the clean room completely before the next candidate. The reset is
   run by the benchmark runner as the candidate account and removes the
   workspace, agent session files, caches, and other task history before
   restoring the original task state.
14. Aggregate only comparable runs into a report with confidence notes.

The runner writes sanitized results into a checkout of the public
`models-test` repository (or an equivalent results directory). It prepares
commits and files but never pushes or publishes automatically. Publication is
a separate manual review and push operation.

## 5. Isolation and Security

- Every run gets a disposable workspace and unique process group.
- Every task starts a new agent session. Session files, history, caches, and
  previous candidate work are removed before the next candidate.
- Candidate processes may read the published task and tests, but cannot read
  reference solutions, provider credentials, private orchestration data, or
  other runs.
- Runner-owned artifacts, judge prompts, raw model output, and aggregate data
  are stored under a private directory in the runner account's home, outside
  the candidate workspace. Permissions and process isolation must prevent the
  candidate account from reading that directory.
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
    "agent": "opencode",
    "runtime": "...",
    "provider": "...",
    "subscription": "free"
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

Each judge scores the resulting code independently on every criterion in the
release rubric. The current pilot uses four criteria:

- functional correctness;
- reliability and edge-case handling;
- maintainability and clarity;
- scope discipline and fit to the task.

The first release should report separate dimensions:

- public correctness;
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
- an aggregation command that emits JSON and Markdown data for a separate
  reporting site or repository.

The private pipeline deliberately does not generate or publish HTML pages.
Presentation is downstream of the sanitized, versioned result data.

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

Before implementation, decide the task revisions, candidate model list, judge
model IDs, criterion set, clean-room reset mechanism, evaluator isolation
technology, rubric calibration, cost accounting, report hosting, and whether a
human review is required for disputes. The pilot selects any three candidates
already listed in the public model comparison. Task, candidate, judge, and
criterion counts remain configurable per release. Retry policy is fixed for the
current pilot: one pass and one chance, with no candidate retry.
