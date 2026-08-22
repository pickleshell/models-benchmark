#!/usr/bin/env node
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validateJudgePayload } from './lib/runner-utils.mjs';

const repo = path.resolve(new URL('..', import.meta.url).pathname);
const configPath = process.env.BENCHMARK_CONFIG
  ? path.resolve(process.env.BENCHMARK_CONFIG)
  : path.join(repo, 'config/pilot.json');
const config = JSON.parse(await readFile(configPath, 'utf8'));
const release = process.argv[2] || config.release;
const root = path.resolve(config.models_test, config.results_dir, release);

function inferOutcome(run) {
  if (run.outcome) return run.outcome;
  if (run.agent?.status !== 0 || run.agent?.timed_out || run.agent?.output_limited) return 'agent_failure';
  if (run.forbidden_changes?.length) return 'forbidden_changes';
  if (run.tests?.status !== 0 || run.tests?.timed_out || run.tests?.output_limited) return 'tests_failed';
  return 'completed';
}

function combineOutcome(taskResults) {
  if (taskResults.some((task) => task.outcome === 'missing_artifacts')) return 'missing_artifacts';
  if (taskResults.some((task) => task.outcome === 'unavailable')) return 'unavailable';
  if (taskResults.some((task) => task.outcome === 'agent_failure')) return 'agent_failure';
  if (taskResults.some((task) => task.outcome === 'forbidden_changes')) return 'forbidden_changes';
  if (taskResults.some((task) => task.outcome === 'tests_failed')) return 'tests_failed';
  return 'completed';
}

function sumDuration(taskResults, field) {
  const values = taskResults.map((task) => task[field]).filter(Number.isFinite);
  return values.length === taskResults.length ? values.reduce((sum, value) => sum + value, 0) : null;
}

const rows = [];
for (const candidate of config.candidates) {
  const taskResults = [];
  const judges = [];
  for (const task of config.tasks) {
    const taskDir = path.join(root, candidate.id, task.id);
    let run;
    try {
      run = JSON.parse(await readFile(path.join(taskDir, 'run.json'), 'utf8'));
    } catch {
      taskResults.push({ task: task.id, outcome: 'missing_artifacts', judge_count: 0, judge_invocation_count: 0, judge_durations: [], judge_duration_ms: null, agent_duration_ms: null, test_duration_ms: null, duration_ms: null });
      continue;
    }
    const outcome = inferOutcome(run);
    let taskJudgeCount = 0;
    const taskJudges = [];
    if (!['agent_failure', 'unavailable', 'forbidden_changes'].includes(outcome)) {
      try {
        for (const file of await readdir(path.join(taskDir, 'judges'))) {
          if (!file.endsWith('.json')) continue;
          const result = JSON.parse(await readFile(path.join(taskDir, 'judges', file), 'utf8'));
          taskJudges.push({
            id: result.judge?.id ?? file.slice(0, -'.json'.length),
            status: result.status ?? 'unknown',
            duration_ms: Number.isFinite(result.execution?.duration_ms) ? result.execution.duration_ms : null
          });
          const valid = result.status === 'completed' ? validateJudgePayload(result, config.criteria) : null;
          if (valid) {
            judges.push(valid);
            taskJudgeCount += 1;
          }
        }
      } catch {}
    }
    taskResults.push({
      task: task.id,
      outcome,
      agent: run.agent,
      tests: run.tests,
      agent_duration_ms: run.agent?.duration_ms ?? null,
      test_duration_ms: run.tests?.duration_ms ?? null,
      duration_ms: run.duration_ms ?? null,
      judge_count: taskJudgeCount,
      judge_invocation_count: taskJudges.length,
      judge_durations: taskJudges,
      judge_duration_ms: taskJudges.every((judge) => Number.isFinite(judge.duration_ms))
        ? taskJudges.reduce((sum, judge) => sum + judge.duration_ms, 0)
        : taskJudges.length ? null : 0
    });
  }
  const judgeAverage = {};
  for (const criterion of config.criteria) {
    const values = judges.map((judge) => judge.scores[criterion]);
    if (values.length) judgeAverage[criterion] = values.reduce((sum, value) => sum + value, 0) / values.length;
  }
  const scoreValues = config.criteria.map((criterion) => judgeAverage[criterion]).filter(Number.isFinite);
  rows.push({
    candidate,
    task_count: taskResults.length,
    tasks: taskResults,
    outcome: combineOutcome(taskResults),
    agent_duration_ms: sumDuration(taskResults, 'agent_duration_ms'),
    test_duration_ms: sumDuration(taskResults, 'test_duration_ms'),
    duration_ms: sumDuration(taskResults, 'duration_ms'),
    judge_duration_ms: sumDuration(taskResults, 'judge_duration_ms'),
    judge_count: judges.length,
    judge_average: judgeAverage,
    overall_average: scoreValues.length === config.criteria.length
      ? scoreValues.reduce((sum, value) => sum + value, 0) / scoreValues.length
      : null
  });
}

rows.sort((a, b) => (b.overall_average ?? -Infinity) - (a.overall_average ?? -Infinity));
const output = { schema_version: 2, release, criteria: config.criteria, candidates: rows, generated_at: new Date().toISOString() };
await mkdir(root, { recursive: true });
await writeFile(path.join(root, 'aggregate.json'), `${JSON.stringify(output, null, 2)}\n`);
const lines = [`# ${release}`, '', '| Candidate | Agent | Model | Tasks | Outcome | Agent time (s) | Candidate + tests (s) | Judge time (s) | Judges | Average |', '|---|---|---|---:|---|---:|---:|---:|---:|---:|'];
for (const row of rows) {
  const average = Number.isFinite(row.overall_average) ? row.overall_average.toFixed(2) : 'N/A';
  const agentDuration = Number.isFinite(row.agent_duration_ms) ? (row.agent_duration_ms / 1000).toFixed(2) : 'N/A';
  const totalDuration = Number.isFinite(row.duration_ms) ? (row.duration_ms / 1000).toFixed(2) : 'N/A';
  const judgeDuration = Number.isFinite(row.judge_duration_ms) ? (row.judge_duration_ms / 1000).toFixed(2) : 'N/A';
  lines.push(`| ${row.candidate.id} | ${row.candidate.agent} | ${row.candidate.model} | ${row.task_count} | ${row.outcome} | ${agentDuration} | ${totalDuration} | ${judgeDuration} | ${row.judge_count} | ${average} |`);
}
await writeFile(path.join(root, 'aggregate.md'), `${lines.join('\n')}\n`);
process.stdout.write(`${JSON.stringify({ release, candidates: rows.length, tasks: config.tasks.length, output: root })}\n`);
