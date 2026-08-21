# Deployment Guide

This guide installs the private benchmark runner on one Linux host. It does not
publish anything. The runner writes sanitized results to a local checkout of
the public task/results repository; publication is a separate human-reviewed
Git operation.

## Roles and directories

Use two Unix accounts:

- **runner account**: owns this private `models-benchmark` checkout and its
  private raw artifacts. The current deployment uses `gpt`.
- **clean-room account**: executes candidates and judges. It owns only its
  disposable workspace, agent home, reset script, and task archive. The
  current deployment uses `test` and must not have sudo access.

The default pilot manifest expects:

```text
/home/gpt/models-benchmark                 private runner checkout
/home/gpt/models-test                      task and sanitized-results checkout
/home/gpt/.models-benchmark/runs           private raw artifacts
/home/test/.models-benchmark               disposable clean-room root
/home/test/.opencode/bin/opencode          OpenCode CLI for the test user
```

Update `config/pilot.json` together with this document if these paths or
accounts change.

## Prerequisites

- Linux with Node.js 20 or newer, Git, sudo, `systemd-run`, and network access
  for the selected OpenCode models.
- The private `models-benchmark` repository and a checkout of `models-test`.
- A dedicated clean-room user with no sudo group membership.
- OpenCode installed for the clean-room user. Free OpenCode models may be used
  without placing provider credentials in the disposable agent home. Do not
  put credentials in `agent-home`: the reset procedure deletes it before every
  candidate and judge.
- The runner account is trusted and needs non-interactive sudo for the runner's
  archive installation, ownership setup, and execution as the clean-room user.
  Do not grant this to the clean-room account.

## Initial installation

Run these commands as the runner account, adjusting paths and account names
only when the manifest is updated too:

```sh
git clone git@github.com:pickleshell/models-benchmark.git /home/gpt/models-benchmark
git clone git@github.com:pickleshell/models-test.git /home/gpt/models-test

sudo useradd --create-home --shell /bin/bash test
sudo -u test -H bash -lc 'curl -fsSL https://opencode.ai/install | bash'

sudo install -d -o gpt -g gpt -m 0700 /home/gpt/.models-benchmark/runs
sudo install -d -o test -g test -m 0755 /home/test/.models-benchmark
```

The runner installs its reset script and copies the configured public task into
the test account automatically at the start of each run. The test account must
not be able to read `/home/gpt/.models-benchmark/runs` or the private runner
checkout.

## Candidate sandbox

Every candidate, public test command, judge, and Git inspection of a
candidate-owned workspace runs in a transient `systemd-run` unit. The sandbox
uses private `/tmp`, `ProtectHome=tmpfs`, a read-only bind of
`clean_room.opencode_root`, and writable binds only for the selected workspace
and disposable agent home. The OpenCode runtime under `/home/test/.opencode`
is therefore not writable or visible to candidate code.

The runner's reset/archive operations are trusted maintenance actions and run
as `test` outside that sandbox. Do not run candidate-controlled commands with
plain `sudo -u test`; doing so would reintroduce cross-run state through the
host home or `/tmp`.

The runner captures at most `BENCHMARK_MAX_OUTPUT_BYTES` per stdout and stderr
stream (default: 2 MiB). Reaching the cap terminates the process group and is
recorded as an execution failure. Adjust the limit only deliberately for a new
release.

## Required sudo boundary

The runner calls `sudo` to prepare the clean-room archive and then launches
all candidate, test, and judge commands as `test`. Verify the intended policy
before running the pilot:

```sh
sudo -n -l -U gpt
id test
```

`id test` must show no administrative supplementary groups. A production
hardening pass may replace the broad runner sudo permission with a restricted
command allowlist, but the clean-room account itself must remain unprivileged.

## Preflight and first run

From the private runner checkout:

```sh
npm run pilot:dry-run
sudo -u test env HOME=/home/test/.models-benchmark \
  PATH=/home/test/.opencode/bin:/usr/local/bin:/usr/bin:/bin \
  opencode --version
```

The dry run validates the configured matrix without invoking models. Review
`config/pilot.json` carefully before the first real run: it defines tasks,
candidates, judges, subscriptions, and the release identifier.

Run the pilot only after that review:

```sh
npm run pilot
npm run aggregate -- <release-id>
```

The runner resets the clean room before every candidate, starts fresh candidate
and judge sessions, and performs one final reset at completion. A real run
spends provider quota and may take several minutes; it must not be retried in
place. Give a rerun a new release identifier.

Release IDs are immutable. The runner refuses to start if either its private
artifact directory or sanitized public result directory for the requested ID
already exists. It never overwrites a partial or prior result.

## Verification and publication

Inspect the generated artifacts under:

```text
/home/gpt/models-test/results/benchmark-pilot/<release-id>/
```

Each `run.json` records `started_at`, `completed_at`, and `duration_ms` for the
candidate execution plus agent and public-test phases. Judge files record their
own execution durations. `aggregate.json` carries comparable result data only;
site rendering is intentionally outside the private pipeline.

`allowed_changes` in the task manifest is enforced before judging. A candidate
that modifies tests, manifests, or another unapproved path is classified as
`forbidden_changes`; its patch and test evidence are retained, but judges are
skipped and no quality score is aggregated.

Before manually committing results, verify that they contain no raw model logs,
credentials, private paths, judge prompts, or hidden evaluation material:

```sh
git -C /home/gpt/models-test status --short
git -C /home/gpt/models-test diff --check
```

The runner never commits or pushes `models-test`. Publication requires a
separate review and deliberate commit in the results repository.

## Recovery

If a run is interrupted, do not reuse its release directory or clean-room
state. Preserve private diagnostics under the runner account, choose a new
release identifier, and rerun from a clean room. A provider-unavailable model
is an availability outcome, not a code-quality score.
