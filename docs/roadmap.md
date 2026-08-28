# Roadmap

Models Benchmark is operational. The core candidate pipeline, clean-room
isolation, objective evaluation, artifact integrity, aggregation, and separate
blind-judging stage are implemented. This roadmap distinguishes completed
foundations from the work needed for a durable public benchmark program.

## Completed foundations

- data-driven release, nomination, candidate, judge, and rubric configuration;
- OpenCode and Codex candidate runtimes;
- harmless model availability preflight;
- sequential clean-room execution with fresh workspace and agent state;
- transient systemd isolation and host-wide run locking;
- trusted baseline comparison and allowed-path enforcement;
- separate public tests and private network-isolated objective evaluators;
- immutable, schema-versioned, hashed attempt artifacts;
- candidate duration and provider-reported solution-cost recording;
- testing-only default pipeline with judging as a separate stage;
- anonymous identity-blind judge workspace reconstruction;
- manual reviews and derived JSON/Markdown aggregate reports;
- cross-task model coverage experiments and runtime-failure rerun policy.

## Near-term hardening

- add an automated installer/verifier for complete native Codex runtime bundles;
- add end-to-end regression coverage for Codex workspace tool execution, not
  only CLI availability;
- distinguish runtime/tool-host failures from genuine candidate failures in a
  dedicated structured classification;
- add a release linter for duplicate candidate routes, missing metadata, and
  inconsistent nomination IDs;
- add a first-class command for creating a new immutable release configuration;
- document and automate safe stale-lock recovery diagnostics;
- add publication-time validation for manual-review schemas.

## Benchmark quality

- expand public tests so obvious seeded defects do not pass most visible cases;
- version hidden evaluator contracts and calibration fixtures explicitly;
- maintain multi-task coverage before publishing cross-model rankings;
- report confidence and task coverage alongside averages;
- track runtime and provider route as comparison dimensions;
- add repeated-run studies only through explicit multi-attempt releases;
- investigate variance across provider availability, reasoning variants, and
  runtime versions.

## Reporting and publication

- generate one consolidated cross-release model × task coverage table;
- expose superseded and infrastructure-invalid attempts explicitly;
- merge objective results, manual reviews, duration, and known price without
  collapsing them into a misleading single score;
- add a static report site sourced only from reviewed sanitized artifacts;
- publish a documented benchmark release process and changelog;
- keep private evaluators and raw logs outside the public results repository.

## Longer-term isolation

- add an egress proxy and provider allowlist for stronger network control;
- evaluate per-attempt containers or lightweight VMs as an alternative clean-room backend;
- attest runtime bundle and system package hashes in release manifests;
- support disposable per-run Unix identities where operationally practical;
- add automated post-run checks for orphaned units, processes, and writable runtime files.

## Release gate

A benchmark release is publishable only when:

- every included model-task pair has a valid or explicitly classified outcome;
- no known infrastructure failure is scored as model quality;
- prompts, fixtures, tests, evaluators, and runtimes are frozen and identifiable;
- candidate testing and judging remain separate;
- objective and manual evidence agree on artifact identity;
- timing and price follow the documented reporting policy;
- public artifacts contain no credentials, raw logs, private evaluator details,
  or candidate identity in blind-judge inputs;
- the aggregate can be regenerated from immutable primary artifacts.
