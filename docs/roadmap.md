# Roadmap

## Phase 0: Design review

- review the technical specification;
- settle security and isolation boundaries;
- define the pilot `feature-implementation` task from `models-test`;
- select three free candidate models across the OpenCode/Codex agents;
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

## Phase 2: Evaluation

- published test and evaluator protocol;
- forbidden-change checker;
- rubric and aggregation;
- deterministic fixture tests.

## Phase 3: Pilot

- provision one dedicated clean-room Linux account;
- run `feature-implementation` once for each of three free models through the
  configured OpenCode or Codex agent;
- create a new agent session for each run and execute the account reset as the
  candidate user before the next model;
- judge every result independently with the configured judge models;
- inspect artifacts and failure classifications;
- calibrate scoring and reproducibility;
- publish an internal report.

## Phase 4: Expanded benchmark

- add two or three tasks after the one-task pipeline pilot passes;
- repeat the isolation, judging, and artifact checks;
- expand the task set only through a new versioned manifest.

## Phase 5: First benchmark release

- tag an immutable release;
- run the complete matrix;
- publish evidence-backed reports;
- document limitations and follow-up work.
