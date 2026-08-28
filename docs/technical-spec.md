# Models Benchmark Technical Specification

## 1. Purpose

Build a versioned pipeline for comparing coding models and agent runtimes on
the same software-maintenance tasks. Results must distinguish code quality from
provider availability, execution failure, timeout, and evaluator failure.

## 2. Non-goals

- A generic leaderboard for language understanding.
- Estimating token or API cost when a provider-reported solution cost is
  unavailable.
- Requiring the benchmark pipeline itself to be public; task data and tests are
  public, while orchestration and judging implementation remain private.
- Ranking models from a single task or a single provider outage.

## 2.1 Benchmark Shape

The benchmark is intentionally close to normal use of a coding agent rather
than a collection of isolated micro-prompts. Counts below are release
configuration, not architectural limits:

- a Benchmark freezes a full roster, then executes one selected Nomination
  across any selected subset of models before moving to another Nomination;
- nominations use versioned public fixtures and prompts from `models-test`;
- a release freezes its complete candidate roster even when an invocation
  selects only a subset;
- task and candidate counts are manifest choices rather than runner constants;
- each task includes the documentation and local context needed to solve it;
- the candidate receives one pass and one chance per task; retries are not
  allowed;
- candidates may use OpenCode or Codex, and every run records the selected
  agent/runtime explicitly;
- task results are preserved before any judging begins.

The benchmark must measure practical end-to-end work, not only the ability to
solve a small isolated function.

### Visible assistant commentary

An append-only `assistant-commentary.jsonl` may retain user-visible ChatGPT
benchmark progress, comments, and summaries for UI use at
`annotations/<release>/<candidate>/`. It is annotation metadata, not benchmark
ground truth: it must not alter candidate outcomes, hidden evaluator inputs or
results, judge inputs, scores, or publication artifacts. Never record private
chain-of-thought, secrets, credentials, hidden evaluator raw output, or
unpublished sensitive internals.

### Cost reporting policy

The primary cost in a leaderboard or table is the provider-reported solution
cost for the candidate task execution. It is the model's displayed task price
and excludes candidate preflight plus every judge, fallback, and expert-review
cost. Candidate total known cost including preflight may remain secondary
telemetry. Input, output, reasoning, and cache token counts are diagnostic
telemetry only and do not replace solution cost.

If provider-reported solution cost is unknown, the value remains `null` and is
rendered as `N/A` where appropriate; the pipeline and reporting layer must
never estimate it from tokens, elapsed time, published rates, or another
proxy. This reporting policy changes presentation only and does not permit
rewriting immutable historical artifacts.

## 3. Core Concepts

- **Benchmark**: the immutable release containing all nominations, the full
  model roster, judging/evaluator contracts, and environment/spec hashes.
- **Nomination**: one concrete benchmark task/category instance: its versioned
  repository state, public instructions, documentation, and public tests.
- **Run**: one specific model executing one Nomination within one Benchmark;
  its logical identity is `(benchmark/release, model/candidate, nomination)`.
- **Attempt**: one immutable execution attempt for a Run. The initial
  execution is attempt 1; a retry creates attempt 2 and never overwrites 1.
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

Candidates, nominations, judges, and criteria are data, not hard-coded runner logic.
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
  "nominations": ["phase1-ledger", "phase2-feature-implementation"],
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

For fresh Phase2-v2 releases beginning with r18, canonical judging is ordered:
first an expert review by ChatGPT `gpt-5.6-sol`, then exactly one identity-blind
AI judge, `gemini-3-7-flash`. The mutable base configuration records the expert
identity and contains only Gemini in `judges`; future fallback orchestration is
limited to that Gemini attempt. Claude Opus 4.8 is removed from future
canonical/fallback use because it is materially more expensive than Gemini and
missed the deterministic hidden signed/fractional `Date.parse` `+1` defect in
multiple completed Patch runs, so its incremental review value did not justify
the recurring cost. Historical Claude results remain immutable evidence. The
frozen r17 Nemotron specification is the final old two-blind-judge run because
it was already in progress at the policy change; its incurred Claude cost stays
recorded. The manifest must record model IDs and provider configuration without
storing credentials.

## 4. Pipeline

1. Freeze the Benchmark, including its full model roster and all nomination,
   evaluator, judge, and environment/spec hashes.
2. Select one Nomination and any subset of roster model IDs; this filter does
   not mutate the Benchmark manifest or release identity.
3. Provision or reset the dedicated clean-room Linux account and prepare that
   Nomination's workspace and documentation.
4. Preflight only the selected models (and judges when that phase requires it).
5. Start every selected available model through its configured agent to create
   exactly one Run per selected model for the Nomination.
7. Enforce timeout, per-stream output limits, process-group cleanup, and
   cancellation.
8. Freeze the complete configured result before judging.
9. Run public tests and the private objective evaluator independently in their
   respective sandbox contracts.
10. Freeze candidate evidence. Only a later explicit judging stage may send
   the resulting code and allowlisted evidence to configured judges.
11. Record every judge response and score; do not ask a judge to reconcile
    another judge's score.
12. Enforce allowed paths and classify forbidden modifications before judging.
13. Persist schema-versioned artifacts and classify every outcome.
14. Reset the clean room completely before the next Attempt. The reset is
   run by the benchmark runner as the candidate account and removes the
   workspace, agent session files, caches, and other task history before
   restoring the original task state.
15. Aggregate only comparable canonical Attempts into a report with confidence notes.

The runner writes sanitized results into a checkout of the public
`models-test` repository (or an equivalent results directory). It prepares
commits and files but never pushes or publishes automatically. Publication is
a separate manual review and push operation.

## 5. Isolation and Security

- Every candidate, test, judge, and candidate-workspace Git operation runs in
  a fresh transient systemd mount namespace. It cannot access the host home,
  host temporary files, another run's workspace, agent state, or artifacts.
  Its only writable state is the disposable workspace, fresh agent home, and
  a private temporary filesystem that disappears with the sandbox. The agent
  runtime is mounted read-only.
- Every task starts a new agent session. Session files, history, caches, and
  previous candidate work are removed before the next candidate.
- Candidate processes may read the published task and tests, but cannot read
  reference solutions, provider credentials, private orchestration data, or
  other runs.
- Runner-owned artifacts, judge prompts, raw model output, and aggregate data
  are stored under a private directory in the runner account's home, outside
  the candidate workspace. Permissions and process isolation must prevent the
  candidate account from reading that directory.
- OpenCode and Codex harnesses retain outbound network access for model
  providers. They must not receive host-home, runner-artifact, or runtime-write
  access. A complete Codex runtime includes its main binary, code-mode host,
  bundled `rg`, bundled `bwrap`, and package metadata; the runner validates
  these before candidate preflight.
- File writes are limited to the disposable workspace, fresh agent home, and
  private per-sandbox temporary filesystem; none survives into another run.
- Timeouts terminate the complete process group and are recorded as outcomes,
  not silently converted to failures of code quality.
- Logs are scrubbed for tokens and credentials before persistence.
- The evaluator runs after candidate teardown, with a separate environment and
  read-only access to benchmark metadata where possible.

### 5.1 Experimental Cleanliness Controls

The benchmark treats every candidate run as an isolated experiment. The
following controls are part of the implemented contract:

1. **Identical starting state.** The runner restores each public fixture from a
   trusted archive before a candidate receives it. Tasks, instructions,
   documentation, baseline Git state, and public tests are release inputs.
2. **Fresh agent state.** The workspace and disposable agent home are removed
   before every candidate and again after the matrix. This removes sessions,
   histories, caches, and files created by the preceding run.
3. **Mount-namespace isolation.** Candidate, test, judge, and Git-inspection
   processes run in separate transient systemd mount namespaces with
   `ProtectHome=tmpfs`, `PrivateTmp=yes`, `PrivateIPC=yes`,
   a dedicated `/dev/shm` mount, `ProtectProc=invisible`, and
   `ProtectSystem=strict`. A process
   cannot access the host home, host temporary filesystem, runner artifacts,
   or a previous sandbox's workspace or agent state.
4. **No shared temporary channel.** Each sandbox has a private temporary
   filesystem and private IPC resources for its own tools. They are distinct from the host temporary
   filesystem, is never mounted into another sandbox, and disappears when that
   sandbox exits. A model cannot leave a result there for a later model.
5. **Least writable state.** The only writable binds are the selected
   disposable workspace and fresh agent home. The configured agent runtime is
   read-only. `NoNewPrivileges`, `PrivateDevices`, `RestrictSUIDSGID`,
   `RestrictNamespaces`, and related systemd restrictions prevent candidate
   code from widening this boundary through normal privilege mechanisms.
6. **Sequential execution and teardown.** Candidate attempts do not overlap.
   Process groups are terminated on timeout or output-limit failure, and the
   sandbox is collected before the next run begins.
7. **Trusted result capture.** The runner compares the final candidate file
   tree against an independently captured baseline rather than trusting the
   candidate's Git HEAD. This captures untracked files and changes committed by
   the candidate.
8. **Policy enforcement.** `allowed_changes` is enforced before judging. A
   patch that changes tests, package metadata, or another unapproved path is a
   `forbidden_changes` result, not a successful solution.
9. **Evidence separation.** Raw stdout, stderr, and diagnostics stay in a
   runner-owned private directory. Public results contain only sanitized,
   reviewable artifacts. In particular, public test results retain execution
   metadata and hashes of private output, never candidate-controlled raw text.
   Hidden evaluator files are resolved only under the runner-private evaluator
   root; the release manifest includes only their ID and content/source hashes.
   The trusted runner copies evaluator, fixture, and immutable patch into a
   disposable root, then transfers that exact root to the clean-room UID before
   mounting it as the evaluator's sole writable bind. Trusted cleanup removes
   it after exit. Objective units use `PrivateNetwork=yes`; with
   `ProtectSystem=strict`, `/usr/bin/node` and its host system libraries remain
   read-only-visible and no OpenCode/runtime/auth bind is present.
10. **Independent blind judging.** Each judge receives a unique anonymous
    workspace rebuilt from the trusted baseline plus one recorded patch, plus a
    fresh agent home. Candidate identity, runtime, provider, subscription,
    logs, original workspace, and private artifacts are excluded from judge
    inputs.
11. **Availability and immutability gates.** Candidate testing and model
    judging are separate stages. Candidates are probed before task assignment;
    selected judges are probed only when the explicit judging stage runs.
    Release directories are immutable, preventing retries from replacing or
    mixing evidence under the same release ID.
12. **Single-run ownership.** A host-wide clean-room lock is acquired before
    any probe or reset and is released only after final cleanup. A second runner
    stops before it can touch the shared clean-room workspace or agent home. The
    lock path is stable across release manifests using that clean room. If final
    cleanup fails, the lock is retained with the failure reason rather than
    allowing a later release to assume a clean state.
13. **Operational verification.** `npm run verify:sandbox` starts two actual
    transient units without invoking a model. It proves that one unit's shared
    memory marker is invisible to the host and to the next unit, compares their
    IPC namespace identifiers with the host, and verifies creation of a SysV
    message queue. `ProtectProc=invisible` hides processes of other users, but
    not processes owned by the same clean-room UID; the runner therefore checks
    that the clean-room account is idle before it starts. The check also confirms
    that the configured read-only runtime remains usable inside the hardened
    boundary. It acquires the same host-wide lock as a pilot and requires an
    idle clean-room account, so it cannot overlap a release. This check is
    required after installing or changing the sandbox configuration.
14. **Non-mutating runtime preflight.** Required OpenCode and/or Codex version
    checks run with only read-only runtime binds and private sandbox storage.
    They do not bind the clean workspace or agent home, so an early
    runtime-preflight failure cannot dirty candidate state. Codex auth is
    installed only after reset into a fresh disposable `CODEX_HOME`; no user
    configuration, history, rules, plugins, memories, or sessions are copied.

These controls protect against accidental state carry-over and ordinary
candidate-controlled writes. They are process and mount-namespace isolation,
not a claim to defend against a compromised kernel or a host administrator.
Outbound network access remains available for model providers. Preventing a
deliberately adversarial model from using an external service as a covert
channel would require a separate proxy-based egress allowlist and is outside
the current benchmark threat model.

## 6. Canonical Run Result

Each run must produce JSON containing at least:

```json
{
  "schema_version": 1,
  "run_id": "run_...",
  "benchmark_version": "v...",
  "nomination": "...",
  "run_id": "<release>:<model>:<nomination>",
  "attempt": 1,
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
  "benchmark_metrics": {
    "duration_ms": 0,
    "model_duration_ms": 0,
    "public_tests_duration_ms": 0,
    "cost_usd": null,
    "cost_source": "opencode_step_finish",
    "includes_preflight": false,
    "includes_judging": false
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

Before the task matrix, every candidate receives one harmless availability
probe. For OpenCode JSON mode, a process exit is insufficient: a recognised
model text event is required. An unavailable model receives a public,
sanitized `preflight.json` and `unavailable` task records; it receives no task,
tests, patch capture, or judge invocation. Raw probe output remains private.
Every selected judge receives the same probe when the separate judging stage
starts. An unavailable judge aborts that judging invocation without consuming
or modifying candidate attempts.

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

Judging is identity-blind. The judge process may receive the task ID, rubric,
the submitted workspace, and an explicit allowlist of public-test status fields,
but must not receive candidate ID, model, agent/runtime, provider, subscription,
candidate stdout/stderr, private artifacts, or candidate-derived paths, prompts,
environment values, or temporary file names. The runner uses an opaque,
cryptographically random workspace name and adds the real candidate association
to the judge artifact only after the judge process exits. The submitted
workspace must be rebuilt from the trusted baseline plus the candidate patch;
candidate `.git` metadata must never be copied, and the judge sandbox must not
have a writable bind for the original candidate workspace. Blind judging hides
declared identity but cannot prevent inference from code style.

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

- a CLI to validate manifests and execute one selected Nomination across a
  selected model subset; `--nomination <id>` is canonical and `--task <id>` is
  deprecated compatibility only;
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


### Canonical per-Nomination scorecard
Each judge returns four 1–10 scores: `functional_correctness`, `reliability_edge_cases , `maintainability_clarity`, and `scope_discipline`. The runner/aggregator computes the arithmetic mean; judge-supplied averages are not authoritative. Scorecards are retained per Nomination and may be aggregated later. Blind judges are not shown hidden objective-evaluator status.
