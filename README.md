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
- isolated execution with no cross-run state or hidden evaluator access;
- deterministic, machine-readable artifacts;
- separate model quality from provider availability and infrastructure errors;
- reproducible local runs and independently verifiable published reports;
- explicit versioning of tasks, rubrics, harnesses, models, and runner code.

## Documentation

- [Technical specification](docs/technical-spec.md)
- [Roadmap](docs/roadmap.md)

The specification is intentionally open for review before implementation.

## Security Boundary

Candidate models run against disposable workspaces with least-privilege
credentials. Hidden tests, reference solutions, and scoring data must never be
available to the candidate process. Secrets, provider tokens, and private
repository contents are not benchmark artifacts.
