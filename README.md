# Models Benchmark

Private benchmark runner for comparing coding models and agent runtimes on the
same real software tasks. Every model gets one clean starting point, one new
agent session, the same public documentation and tests, and one chance to
produce a solution. The runner preserves the resulting patch, public test
evidence, elapsed time, and independent model reviews as structured data.

The benchmark answers a practical question: given the same task and normal
coding-agent tools, what did each model actually deliver? It keeps code quality
separate from availability, provider failures, and infrastructure problems.
Public tasks and reviewed results live in `models-test`; this private repository
contains the orchestration needed to make the comparison fair.

## Current Status

The clean-room runner, isolated blind-judging workflow, and sanitized result
format are implemented. `pilot-2-tasks-r4` was an operational diagnostic run:
it found unavailable candidate and judge models and is not a publishable model
comparison. The next immutable run is `pilot-2-tasks-r5`.

The clean-room boundary is verified on the benchmark host with
`npm run verify:sandbox`. This non-model smoke check starts two real transient
systemd units and confirms that private shared memory is absent from both the
host and the next unit, that the units use distinct IPC namespaces, and that
the read-only OpenCode runtime can still start inside the same sandbox. It also
records the relevant same-UID process limitation described below. The check
uses no model quota and creates no benchmark release.

The project remains in pilot validation. Two tasks and one run per model are
useful evidence, not a definitive general ranking.

The current pilot configuration is data-driven: candidate models, judges,
tasks, criteria, subscription labels, and release ID live in
[`config/pilot.json`](config/pilot.json). Their counts can change in later
releases without changing the runner's core workflow.

### Next Pilot Matrix

Release `pilot-2-tasks-r5` contains two tasks, three candidate models, and two
independent judges. Candidate models are invoked through OpenCode with the
subscription label `free`; the judges are GPT and Gemini models, also invoked
through OpenCode:

| Role | ID | Model |
| --- | --- | --- |
| Candidate | `big-pickle` | `opencode/big-pickle` |
| Candidate | `deepseek-v4-flash-free` | `opencode/deepseek-v4-flash-free` |
| Candidate | `mimo-v2-5-free` | `opencode/mimo-v2.5-free` |
| Judge | `gpt-5-4-pro` | `gpt-5.4-pro` |
| Judge | `gemini-3-1-pro` | `gemini-3.1-pro` |

The task, candidate list, judge list, and criteria are release inputs, not
constants. Future releases may add tasks, models, judges, subscription tiers,
or a Codex candidate runtime.

The current tasks are `feature-implementation` and `refactoring`. The former
adds a feature-flag resolution behavior; the latter removes duplicated event
filtering while preserving the public API and malformed-input behavior.

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
- [Deployment guide](docs/deployment.md)

The technical specification defines the broader benchmark contract; this README
describes the implemented pilot and how its evidence is stored.

## What Is Tested

This is a coding-agent benchmark, not a generic question-answering benchmark.
Each candidate receives the same public task fixture, task instructions,
documentation, starting Git baseline, and public tests. The current pilot runs
the public `feature-implementation` and `refactoring` tasks from `models-test`.

For every candidate/task pair, the pipeline records:

- whether the agent process completed, timed out, or failed;
- the resulting Git diff and changed-file list;
- the public test result and output;
- agent, test, and combined candidate-execution timings;
- each independent judge's scores, confidence, explanation, and concerns.

The current rubric has four dimensions: functional correctness, reliability
and edge cases, maintainability and clarity, and scope discipline. A passing
public test suite is evidence, not an automatic perfect score.

Judging is identity-blind. Each judge examines an anonymous isolated copy of the
submitted workspace, runs the public tests, and is asked to return structured
scores from 1 to 10 with confidence, explanation, and concerns. The judge
process receives no candidate ID, model, agent/runtime, provider, subscription,
candidate logs, private artifacts, or candidate-derived path. The workspace is
rebuilt from the trusted task baseline and the recorded candidate patch; the
candidate's `.git` directory is never copied, and the judge sandbox can write
only to that anonymous workspace and its fresh agent home. For a completed candidate,
the aggregate averages each criterion across valid judge responses. Its
`overall_average` is the arithmetic mean of all four criterion averages.
Invalid judge output is retained as evidence but excluded from score math;
missing evidence is never converted to zero.

Blind judging hides the declared candidate identity, but it cannot guarantee
that a judge will not infer a model from stylistic or other characteristics of
the submitted code.

## Roles

| Role | Responsibility | Current pilot |
| --- | --- | --- |
| Candidate | Performs the task once in the clean room | Three configured OpenCode models |
| Judge | Independently inspects the resulting workspace and runs public tests | GPT-5.4 Pro and Gemini 3.1 Pro through OpenCode |
| Orchestrator | Starts/reset runs, captures evidence, and reports progress | Codex plus the private runner |

Candidates never see another candidate's workspace, patch, session history,
agent home, judge prompt, judge output, reference solution, runner artifacts,
or provider credentials. Judges receive an anonymous copy of one completed
submission and a fresh agent home of their own.

## How The Pilot Works

Codex acts as the visible orchestrator. It reads the private runner
configuration, starts the pilot, reports live progress, and stops on an
unexpected failure. Candidate models are executed one at a time in the clean
room through their configured OpenCode or Codex agent.

```mermaid
flowchart TD
    A[User gives Codex the benchmark command] --> B[Private models-benchmark runner]
    B --> C[Reset clean-room account as candidate user]
    C --> D[Restore the next public task]
    D --> E[Start a new OpenCode or Codex session]
    E --> F[Candidate model works once]
    F --> G[Run public tests and collect diff]
    G --> H[Save raw output in runner HOME]
    H --> I[Write sanitized artifacts to models-test checkout]
    I --> J[Manual review and publication]
    J --> K[Reset room before next candidate]
    K --> C
```

The next hardened pilot uses two public tasks and three models already present
in the published comparison. Each model receives one pass and one chance per
task. There is no retry and no reuse of a previous agent session.

Before creating a release, the runner also probes every required judge. If a
judge model is unavailable, the run stops before any candidate is given a task
and before any release directory is created. This prevents a costly candidate
matrix with no usable scoring evidence.

The pilot clean room is the dedicated Linux account `test`. Before every
candidate, the runner removes the previous workspace and agent state and
restores the public task from a trusted archive. Candidate commands then run
inside a new transient systemd sandbox. The sandbox exposes only that
candidate's workspace, a fresh agent home, the read-only agent runtime, and a
private disposable temporary filesystem. It cannot see the host home, host
temporary files, the runner's artifacts, or any previous candidate's workspace
or session history.

The clean room is also reset once after the complete configured matrix. This
means a candidate gets one attempt, a new agent session, and no files or
history from a previous candidate. A rerun is a new benchmark release, never a
retry hidden under the same result directory.

## What Keeps A Run Fair

The benchmark does not rely on models behaving politely. It makes the starting
point, execution environment, evidence, and review process explicit.

| Control | What it protects |
| --- | --- |
| Same public baseline | Every candidate receives the same fixture, instructions, documentation, and public tests. |
| One attempt | A candidate gets one new agent session per task. There is no retry or reuse of a previous session. |
| Clean-room reset | Before every candidate, the prior workspace and agent state are removed and the trusted task archive is restored. |
| Separate sandbox | Every candidate, test, and judge runs in a new systemd mount namespace, not in the host account's normal environment. |
| No cross-run files | A sandbox cannot see the host home, host temporary files, runner artifacts, or another model's workspace, session, or agent home. |
| Private temporary storage | A model may use temporary files during its own run, but that storage is private to its sandbox and disappears when the process ends. Another model cannot find it. |
| Private IPC and shared memory | SysV/POSIX IPC and `/dev/shm` are isolated per transient unit, so they cannot carry data from one candidate or judge to the next. |
| Host-process guard | `ProtectProc=invisible` hides processes owned by other users. Before a run, the runner also refuses to start while *any* `test`-owned process exists, because same-UID processes remain mutually visible. |
| Read-only runtime | The OpenCode installation is mounted read-only, so a candidate cannot alter the agent runtime used by later runs. |
| Limited writes | Candidate-controlled processes can write only their disposable workspace, fresh agent home, and private temporary storage. |
| Trusted comparison | The runner compares the final file tree with a trusted baseline, including untracked files and changes hidden by a candidate commit. |
| Change policy | Changes outside a task's `allowed_changes` are classified as `forbidden_changes` and never receive a quality score. |
| Private raw evidence | Raw model output and operational diagnostics stay in the runner account's private directory; only sanitized artifacts enter `models-test`. |
| Blind judging | Each judge receives a fresh anonymous workspace rebuilt from the trusted baseline plus one patch. It never receives candidate identity, logs, original workspace, or another judge's work. |
| Availability gate | Required judges are checked before a release exists; candidates are checked before receiving a task. Provider availability is never confused with code quality. |
| Single-run lock | A host-wide lock prevents two releases from resetting or using the same clean room at the same time. |
| Immutable releases | A release ID cannot be reused. A rerun always has a new identifier and cannot overwrite or mix prior evidence. |

In particular, a model cannot leave a solution in a shared temporary directory
for the next model to discover. The runner gives each transient sandbox its own
temporary filesystem. It is not the host temporary filesystem, is not shared
with another sandbox, and is discarded at teardown.

The sandbox retains outbound network access because OpenCode must reach its
model providers. This benchmark is designed to prevent accidental local state
carry-over and ordinary execution mistakes; it is not an adversarial-network
containment system for a model deliberately trying to publish data to an
external service. A proxy-based egress allowlist is a separate hardening stage.

The lock is deliberately fail-closed. If a runner is killed before cleanup, or
the final reset fails, the lock remains marked with the cleanup failure. The
next release stops rather than guessing that the room is safe. An operator must
inspect the lock owner, confirm that no benchmark process remains, restore the
clean room if necessary, and only then remove that exact stale lock. This is
preferable to risking a mixed run.

## Repository Boundaries

`models-benchmark` is private and contains the runner, manifests, reset
orchestration, judge configuration, and private raw artifacts. The task itself
and its public tests remain available in `models-test`.

The candidate account can read the published task and tests, but cannot read
runner-owned raw logs, judge prompts, reference solutions, credentials, or
other candidates' results. The runner writes only sanitized result files to
the `models-test` checkout. It never pushes them automatically.

## Outcome Rules

Code quality and operational availability are deliberately different facts.

| Outcome | Meaning | Judge scores |
| --- | --- | --- |
| `completed` | Candidate exited successfully and public tests were evaluated | Included when a judge returns valid structured scores |
| `tests_failed` | Candidate completed but public tests failed | Retained and may be judged |
| `agent_failure` | A started candidate process, timeout, or infrastructure step failed | Judges are skipped; aggregate score is `N/A` |
| `unavailable` | A harmless preflight request received no model response | Tasks are not started; judges are skipped and quality is `N/A` |
| `forbidden_changes` | Candidate changed a path outside the task's `allowed_changes` policy | Patch and test evidence are retained; judges are skipped |

Timeout is additionally recorded as `agent.timed_out: true` in `run.json`. An
unavailable provider must not become a zero-quality row or silently vanish from
a report. It remains visible as an availability result with `N/A` quality data.

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

After a pilot, build the local summary without publishing it:

```sh
npm run aggregate -- pilot-1-task-r6
```

The aggregate ignores judge scores for unavailable, failed, or policy-violating
candidates. They remain visible with an explicit outcome rather than receiving
a zero-quality score.

Each future `run.json` records `started_at`, `completed_at`, and `duration_ms`
for the candidate execution, agent phase, and public-test phase. Judge
artifacts record their execution duration too. Existing artifacts created
before this field was introduced intentionally remain without reconstructed
timing.

## Result Layout

The complete public release tree looks like this:

```text
<release>/
  aggregate.json
  aggregate.md
  <candidate>/
    preflight.json
    <task>/
      run.json
      candidate.diff
      test-result.json
      judges/<judge-id>.json
```

An unavailable candidate has a deliberately smaller artifact set:

```text
<candidate>/preflight.json
<candidate>/<task>/run.json
```

`preflight.json` records the safe availability result and timing. The skipped
task records contain `outcome: "unavailable"`; there is no patch, test output,
or judge result because the model never received the task. `aggregate.json` and
`aggregate.md` are written once at the release root, never inside a task.

The pipeline publishes data only. A separate site or reporting repository may
render it. `run.json` includes candidate, test, and overall execution timing;
`aggregate.json` preserves the same duration data. Reports must render
availability failures as `N/A`, not as zero-quality scores.

`run.json` records the benchmark release, task, agent, runtime, model,
subscription, execution status, changed files, and artifact locations. Raw
agent stdout/stderr remains under the private runner artifact directory.

### Public Artifact Fields

| File | Contents | Publication rule |
| --- | --- | --- |
| `<candidate>/preflight.json` | Availability-probe status and timing, without raw output | Sanitized and reviewable |
| `run.json` | Candidate identity, selected agent/runtime, statuses, timestamps, durations, changed files | Sanitized and reviewable |
| `candidate.diff` | Final Git patch against the baseline | Sanitized and reviewable |
| `test-result.json` | Public test exit status, timing, stdout, stderr | Sanitized and reviewable |
| `judges/<id>.json` | Judge identity, scores, confidence, explanation, concerns, timing | Sanitized and reviewable |
| `aggregate.json` / `aggregate.md` | Comparable rows and score averages | Generated locally, manually reviewed |

The runner's own raw stdout/stderr and operational diagnostics stay under
`~/.models-benchmark/runs` owned by the runner account. They are never copied
to the results checkout by the normal workflow.

## Publication Sequence

1. Run the matrix once for a new release identifier.
2. Generate the aggregate data.
3. Inspect the sanitized result directory and verify that no private paths,
   prompts, logs, hidden data, or secrets entered it.
4. Commit and push the results only in a separate manual action.
5. Let a site or other reporting layer consume the published JSON/Markdown.

The private pipeline generates data only. It does not build HTML and does not
publish a website. Presentation must not alter, replace, or conceal the raw
sanitized evidence.

## Pilot Limits

- Two public tasks cannot establish a general model ranking.
- A candidate gets one attempt; provider availability is measured separately
  from patch quality.
- Tasks and public tests are visible to candidates by design. Private prompts,
  raw logs, reference solutions, and credentials are not.
- The pilot currently measures execution time, not token cost or price.
- Results require manual review before publication; a successful local run is
  not automatically a public benchmark release.

## Clean-Room Guarantee

Models are deliberately isolated from one another. A model can see only the
public task it has been assigned and the files it creates during that one run.
It cannot read answers, patches, logs, sessions, or temporary files from an
earlier or later model. The same separation applies to judges: each judge sees
one anonymous submission, never the original candidate workspace or another
judge's work.

Tasks and public tests are intentionally visible. Reference solutions, judge
prompts, scoring data, secrets, provider tokens, private runner files, and all
cross-run artifacts are outside the sandbox and unavailable to model processes.

Candidate, test, and judge stdout/stderr are capped at 2 MiB per stream by
default. Exceeding the cap terminates the process and records an execution
failure, preventing unbounded runner-memory use. The task's `allowed_changes`
policy is enforced before judging, so a model cannot obtain a completed result
by changing tests or package metadata.
