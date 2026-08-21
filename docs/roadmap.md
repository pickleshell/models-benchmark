# Roadmap

## Phase 0: Design review

- review the technical specification;
- settle security and isolation boundaries;
- define the hardened pilot `feature-implementation` and `refactoring` tasks
  from `models-test`;
- select any three already-tested candidate models from the public comparison;
- define configurable candidate, task, judge, and rubric manifests;
- agree on the pilot scoring criteria;
- specify the clean-room reset procedure.

## Phase 1: Core pipeline

- repository/task manifest schema;
- disposable worktree runner;
- harness interface and normalized events;
- timeout and process cleanup;
- artifact schema and validator.
- runner-home private artifact directory with candidate-inaccessible permissions.
- results checkout prepared for manual review and publication to `models-test`.

## Phase 2: Evaluation

- published test and evaluator protocol;
- forbidden-change checker;
- rubric and aggregation;
- deterministic fixture tests.

## Phase 3: Pilot

- provision one dedicated clean-room Linux account;
- run `feature-implementation` and `refactoring` once for each of three
  selected models through the configured OpenCode or Codex agent;
- create a new agent session for each run and execute the account reset as the
  candidate user before the next model;
- write sanitized result artifacts to the `models-test` checkout without
  automatic push;
- judge every result independently with the configured judge models;
- inspect artifacts and failure classifications;
- calibrate scoring and reproducibility;
- publish an internal report.

## Phase 4: Expanded benchmark

- add a third task after the two-task hardened pilot passes;
- repeat the isolation, judging, and artifact checks;
- expand the task set only through a new versioned manifest.

## Phase 5: First benchmark release

- tag an immutable release;
- run the complete matrix;
- publish evidence-backed reports;
- document limitations and follow-up work.
