# Benchmark table publication contract

This document defines the supported result-table formats produced from the
benchmark pipeline. Check it before publishing or changing a PickleShell result
table. The current isolated patch table,
`model-comparison-phase2-patch-current.html`, is the primary visual and semantic
reference. The website repository keeps a matching `TABLE_FORMATS.md`.

## Shared rules

- Render tables inside a horizontally scrollable `.table-scroll` container.
- Include an accessible `<caption>` and sortable heading buttons when sorting
  is available.
- Keep one result per row and one meaning per column.
- Never publish internal numeric status flags such as `agent_status = 0` or
  `evaluator_status = 1`.
- Put a human-readable run status below the rank. Supported labels include
  `completed`, `tests_failed`, `objective_failed`, `forbidden_changes`,
  `agent_failure`, and `unavailable`.
- Every failed or unavailable row must expose a model-specific explanation
  behind its status badge (for example, an accessible `i` popover). Derive it
  from the sanitized public artifact: identify the stage that failed, the
  observable event, and whether the model received the task, produced a patch,
  and passed the public checks. A raw code such as `process_failure`, `1`, or
  `timeout` is supporting metadata, never the whole reader-facing explanation.
- Keep deterministic `Public` and `Objective` checks separate from review
  scores. Historical pages may call the objective column `Hidden`.
- Review criteria are integer values from 0 to 10. `Overall` is their
  arithmetic mean and may be fractional. A missing review is `N/A`, not zero.
- Display agent wall-clock solution time in seconds with three decimal places.
  Do not describe it as model inference speed.
- Display solution-only provider-reported USD cost. Unknown cost remains `N/A`
  and must not be reconstructed.
- When `Channel` is present, do not repeat the provider in parentheses in the
  model name.
- Preserve unavailable and failed rows. Sort them after scored rows rather than
  silently removing them.
- Every body row must have exactly the same cell count as the header.
- Use consistent badges, colors, and `N/A` treatment across table families.

## Format A: current single-task benchmark

This is the default format for current isolated and clean-room results.

| Position | Heading | Content |
|---:|---|---|
| 1 | Rank / status | Canonical rank and human-readable status badge |
| 2 | Model | Model and optional candidate/route ID; no provider suffix |
| 3 | Public | Public-test pass/fail badge |
| 4 | Objective | Objective pass/fail badge |
| 5 | Functional | Integer score, 0–10, or `N/A` |
| 6 | Reliability | Integer score, 0–10, or `N/A` |
| 7 | Maintainability | Integer score, 0–10, or `N/A` |
| 8 | Scope | Integer score, 0–10, or `N/A` |
| 9 | Overall | Arithmetic mean of columns 5–8 |
| 10 | Time (s) | Agent wall-clock solution time |
| 11 | Cost | Provider-reported solution cost or `N/A` |
| 12 | Channel | Access channel/provider route |

Longer criterion headings such as `Functional correctness` or `Scope
discipline` are equivalent when space permits.

## Format B: historical single-task archive

Historical tables may use `Hidden` instead of `Objective` and may append an
`Evidence` column linking to immutable records. Otherwise they follow Format A.
If historical cost or channel data is unavailable, omit the corresponding
column rather than inventing a value.

Expected order:

1. Rank / status
2. Model
3. Public
4. Hidden
5. Functional
6. Reliability
7. Maintainability
8. Scope
9. Overall
10. Time (s)
11. Evidence (optional)

Do not add separate `Record status`, `Agent status`, or `Evaluator status`
columns. Place meaningful run state under `Rank / status`; deterministic failure
evidence belongs in `Public` and `Hidden`.

## Format C: multi-task aggregate

Use only when one row summarizes multiple tasks. The aggregate may add these
measurements before the review criteria:

- `Reviewed`: reviewed patches divided by total tasks;
- `Harnesses passed`: tasks where all required deterministic checks passed;
- `Public`: public-test pass count;
- `Hidden` or `Objective`: objective pass count.

Use `Avg time (s)` rather than `Time (s)`. `Evidence` may link to aggregate
records. Status remains human-readable under rank; raw numeric status columns
are prohibited.

## Format D: legacy Phase 1 quality table

The Phase 1 ledger table may retain its five historical review dimensions:
`Simplicity`, `Readability`, `No extra code`, `Reliability`, and `Edge cases`.
It must still follow the shared rank/status, time, channel, cost, missing-value,
and provider-naming rules.

## Current inventory

| Pages | Family | Columns | Audit result |
|---|---|---:|---|
| Current isolated patch | A | 12 | Canonical reference |
| Five current `llm-test-*.html` result pages | A | 12 | Structurally aligned |
| Five historical per-task Phase 2 pages | B | 14 | Normalize status columns and retain Evidence |
| Historical Phase 2 aggregate | C | 16 | Normalize status columns; aggregate metrics are valid |
| Historical Phase 1 ledger table | D | 11 | Accepted legacy rubric |

## Publication gate

Before publication:

1. Select a format and document any intentional exception.
2. Compare heading order with that format.
3. Verify every body row has the header's cell count.
4. Verify status is descriptive text, not `0`, `1`, `true`, or `false`.
5. For Format A, verify the complete column order is: `Rank / status`, `Model`,
   `Public`, `Objective` (or historical `Hidden`), `Functional`, `Reliability`,
   `Maintainability`, `Scope`, `Overall`, `Time (s)`, `Cost`, `Channel`.
   An intentional format exception must be documented before publication.
6. Verify criterion scores are integers and only `Overall` is averaged.
7. Verify time and cost units and preserve unknown values.
8. Verify provider names are not duplicated in Model and Channel.
9. Execute page JavaScript and test sorting, including `N/A` rows.
10. Check the deployed DOM, not only local source files.
11. Open every failure/unavailable explanation and verify that it is specific
    to that model's sanitized evidence and contains no raw logs or secrets.
