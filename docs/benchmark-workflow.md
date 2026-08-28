# Benchmark Workflow

This guide describes how to define, execute, inspect, and publish a benchmark
release. It is the operator-facing companion to the formal
[technical specification](technical-spec.md).

## Concepts

- **Release**: an immutable benchmark specification and full roster.
- **Nomination**: one versioned task, prompt, fixture, public test command,
  allowed-change policy, and optional private evaluator.
- **Candidate**: a model plus its OpenCode or Codex runtime configuration.
- **Run**: one `(release, candidate, nomination)` combination.
- **Attempt**: one immutable execution of a run.
- **Objective result**: deterministic private evaluation of the resulting patch.
- **Judge result**: a separate identity-blind model review.
- **Aggregate**: a derived table built from immutable primary artifacts.

## 1. Create a release configuration

Copy the shape of a recent compatible configuration in `config/` and assign a
new release ID. Do not edit a frozen configuration whose release already has
artifacts.

Each nomination defines:

```json
{
  "id": "patch",
  "fixture": "fixtures/example",
  "prompt": "benchmarks/example/prompts/patch.md",
  "test_command": ["npm", "test", "--prefix", "fixtures/example"],
  "allowed_changes": ["fixtures/example/src/target.js"],
  "objective_evaluator": {
    "id": "example-patch-v1",
    "path": "example/patch.mjs",
    "source": "fixtures/example/src/target.js"
  }
}
```

Paths to the fixture, prompt, and source are relative to `models_test`.
Evaluator paths are relative to `private_evaluators_dir`; evaluator paths and
symlink escapes fail closed.

Candidate examples:

```json
{
  "id": "openrouter-example",
  "agent": "opencode",
  "model": "openrouter/vendor/model",
  "subscription": "paid",
  "reasoning_variant": "provider_default"
}
```

```json
{
  "id": "codex-example",
  "agent": "codex",
  "model": "gpt-example",
  "reasoning_variant": "provider_default"
}
```

Candidate IDs must be unique within a release. Keep distinct IDs for the same
model reached through different runtimes or provider routes.

## 2. Validate without model calls

Run the project tests and inspect the exact planned matrix:

```bash
npm test
BENCHMARK_CONFIG=config/<release>.json npm run pilot -- --dry-run
git diff --check
```

The dry-run output lists the release, nominations, candidates, run IDs,
attempt, phase, and selected judges. It does not acquire the clean-room lock,
contact providers, or create result artifacts.

After deployment or sandbox changes, also run:

```bash
npm run verify:sandbox
npm run verify:objective-sandbox
```

Do not run either verifier concurrently with a benchmark.

## 3. Run candidate testing

Run the complete candidate roster:

```bash
BENCHMARK_CONFIG=config/<release>.json npm run pilot
```

Or select a subset without changing the frozen release manifest:

```bash
BENCHMARK_CONFIG=config/<release>.json npm run pilot -- \
  --candidate candidate-a,candidate-b \
  --nomination patch
```

For each selected candidate the runner:

1. validates the required runtime;
2. resets the workspace and agent home;
3. sends `Reply with exactly: hi. Do not modify files.`;
4. records `unavailable` and skips the task if no valid response is produced;
5. resets again and starts a fresh task session;
6. captures the final tree against a trusted baseline;
7. enforces the nomination's allowed paths;
8. runs the private objective evaluator and public tests in separate sandboxes;
9. writes immutable sanitized artifacts and private raw diagnostics;
10. resets the clean room before continuing.

Candidate testing never probes or invokes judges.

## 4. Resume safely

Use `--resume` only to verify and skip compatible completed artifacts while
continuing missing candidates:

```bash
BENCHMARK_CONFIG=config/<release>.json npm run pilot -- --resume
```

Resume does not overwrite a primary artifact. Partial or incompatible evidence
fails closed. If an infrastructure defect invalidated a completed attempt,
create a new release ID. Preserve the invalid release as diagnostic history.

## 5. Inspect candidate evidence

For each attempt inspect:

- `run.json` for outcome, identity, changed paths, timings, and cost;
- `candidate.diff` for the actual submitted patch;
- `test-result.json` for public-test process metadata;
- `objective-evaluator.json` for deterministic pass/fail;
- private stdout/stderr only when diagnosing infrastructure or model behavior.

Do not infer objective correctness from `outcome: completed`. That outcome
means the agent and public test command completed successfully. The objective
evaluator is an independent result.

### Result interpretation

| Public tests | Objective | Interpretation |
| --- | --- | --- |
| pass | pass | Patch satisfies all implemented checks |
| pass | fail | Happy path works, but hidden contract or edge cases fail |
| fail | fail/pass | Public contract failed; inspect the patch and test evidence |
| absent | absent | Candidate was unavailable or agent execution failed |

Infrastructure errors must not be scored as model quality. Confirm that a
candidate actually changed the expected file and that its runtime tools were
available. A runtime packaging failure requires a new release and rerun.

## 6. Generate aggregate reports

```bash
BENCHMARK_CONFIG=config/<release>.json npm run aggregate
```

This writes `aggregate.json` and `aggregate.md` under the public release
directory. Aggregates are derived and can be regenerated. They report:

- candidate identity and runtime;
- task coverage and outcome;
- candidate task duration;
- provider-reported solution cost or `N/A`;
- objective pass count;
- judge coverage and averages when judging exists.

Aggregation never invents missing prices or scores.

## 7. Add manual evaluation

A manual review uses the published rubric:

- `functional_correctness`;
- `reliability_edge_cases`;
- `maintainability_clarity`;
- `scope_discipline`.

Store it under:

```text
<attempt>/manual-reviews/<reviewer-id>.json
```

The review should reference observable patch and test evidence. Record whether
identity was hidden. A manual review is annotation data; it must not alter the
candidate run or objective result.

## 8. Run identity-blind judges separately

After candidate evidence is frozen:

```bash
BENCHMARK_CONFIG=config/<release>.json \
  npm run pilot:judges -- --judge <judge-id>
```

Use `--resume` when appending a missing judge to an existing compatible
release. The runner reconstructs a fresh anonymous workspace from the trusted
baseline and immutable diff. The judge must not receive:

- candidate ID or model name;
- runtime, provider, or subscription;
- candidate logs or private paths;
- hidden evaluator identity, code, or result;
- candidate workspace or `.git` metadata.

## 9. Timing and price rules

The primary benchmark duration and price describe the task-solving candidate
call. Availability preflight and judging are excluded.

Use the exact stored provider report:

- known provider cost → numeric `cost_usd`;
- provider does not report cost → `null`, rendered as `N/A`;
- never estimate from tokens, elapsed time, public rates, or another route.

OpenCode commonly emits cost and token telemetry. Codex CLI currently provides
usage context but not a reliable monetary task price, so Codex cost remains
unknown.

## 10. Publication

The runner never commits or pushes public results. Before publication:

```bash
git -C /home/gpt/models-test status --short
git -C /home/gpt/models-test diff --check
```

Review all new files for:

- credentials or token-like values;
- raw model output;
- runner-private paths;
- private evaluator code or diagnostic output;
- judge prompts containing candidate identity;
- accidental fixture or test modifications.

Only then create a deliberate commit in `models-test`.

## Operational checklist

Before a release:

- [ ] New immutable release ID selected.
- [ ] Candidate and nomination roster reviewed.
- [ ] Prompt, fixture, allowed paths, and evaluator reviewed.
- [ ] Runtime and provider route recorded explicitly.
- [ ] `npm test` passes.
- [ ] Dry-run matrix matches intent.
- [ ] Clean-room account is idle.
- [ ] Sandbox verification is current.

After a release:

- [ ] Every selected model has a preflight and run outcome.
- [ ] Completed candidates have a real diff or an intentionally empty solution.
- [ ] Public and objective results were interpreted separately.
- [ ] Timing and price fields follow the reporting policy.
- [ ] Aggregate files regenerate successfully.
- [ ] Manual or blind reviews are stored separately.
- [ ] Public artifacts passed secret and path review.
