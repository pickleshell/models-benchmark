# Roadmap

## Phase 0: Design review

- review the technical specification;
- settle security and isolation boundaries;
- define the six-task set from `models-test`;
- define candidate and judge manifests;
- agree on the three/four scoring criteria;
- specify the clean-room reset procedure.

## Phase 1: Core pipeline

- repository/task manifest schema;
- disposable worktree runner;
- harness interface and normalized events;
- timeout and process cleanup;
- artifact schema and validator.

## Phase 2: Evaluation

- public and hidden evaluator protocol;
- forbidden-change checker;
- rubric and aggregation;
- deterministic fixture tests.

## Phase 3: Pilot

- provision one dedicated clean-room Linux account;
- run the six tasks sequentially for free OpenCode models;
- judge every result independently with ChatGPT and Gemini;
- inspect artifacts and failure classifications;
- calibrate scoring and reproducibility;
- publish an internal report.

## Phase 4: First benchmark release

- tag an immutable release;
- run the complete matrix;
- publish evidence-backed reports;
- document limitations and follow-up work.
