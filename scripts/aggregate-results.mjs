#!/usr/bin/env node
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const repo = path.resolve(new URL('..', import.meta.url).pathname);
const config = JSON.parse(await readFile(path.join(repo, 'config/pilot.json'), 'utf8'));
const release = process.argv[2] || config.release;
const root = path.resolve(config.models_test, config.results_dir, release);
const rows = [];

for (const candidate of await readdir(root, { withFileTypes: true })) {
  if (!candidate.isDirectory()) continue;
  const taskDir = path.join(root, candidate.name, config.tasks[0].id);
  let run;
  try { run = JSON.parse(await readFile(path.join(taskDir, 'run.json'), 'utf8')); } catch { continue; }
  const judgeDir = path.join(taskDir, 'judges');
  const judges = [];
  try {
    if (run.agent.status !== 0) throw new Error('candidate failed');
    for (const file of await readdir(judgeDir)) {
      if (!file.endsWith('.json')) continue;
      const result = JSON.parse(await readFile(path.join(judgeDir, file), 'utf8'));
      if (result.status === 'completed' && result.scores) judges.push(result);
    }
  } catch {}
  const averages = {};
  for (const criterion of config.criteria) {
    const values = judges.map((judge) => Number(judge.scores[criterion])).filter(Number.isFinite);
    if (values.length) averages[criterion] = values.reduce((sum, value) => sum + value, 0) / values.length;
  }
  rows.push({
    candidate: run.candidate,
    task: run.task,
    outcome: run.agent.status !== 0 ? 'agent_failure' : run.tests.status !== 0 ? 'tests_failed' : 'completed',
    agent: run.agent,
    tests: run.tests,
    duration_ms: run.duration_ms ?? null,
    agent_duration_ms: run.agent?.duration_ms ?? null,
    test_duration_ms: run.tests?.duration_ms ?? null,
    judge_count: judges.length,
    judge_average: averages
  });
}

rows.sort((a, b) => (Object.values(b.judge_average)[0] || 0) - (Object.values(a.judge_average)[0] || 0));
const output = { schema_version: 1, release, criteria: config.criteria, candidates: rows, generated_at: new Date().toISOString() };
await mkdir(root, { recursive: true });
await writeFile(path.join(root, 'aggregate.json'), `${JSON.stringify(output, null, 2)}\n`);
const lines = [`# ${release}`, '', '| Candidate | Agent | Model | Outcome | Agent time (s) | Candidate + tests (s) | Judges | Average |', '|---|---|---|---|---:|---:|---:|---:|'];
for (const row of rows) {
  const values = Object.values(row.judge_average).filter(Number.isFinite);
  const average = values.length ? (values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2) : 'N/A';
  const agentDuration = Number.isFinite(row.agent_duration_ms) ? (row.agent_duration_ms / 1000).toFixed(2) : 'N/A';
  const totalDuration = Number.isFinite(row.duration_ms) ? (row.duration_ms / 1000).toFixed(2) : 'N/A';
  lines.push(`| ${row.candidate.id} | ${row.candidate.agent} | ${row.candidate.model} | ${row.outcome} | ${agentDuration} | ${totalDuration} | ${row.judge_count} | ${average} |`);
}
await writeFile(path.join(root, 'aggregate.md'), `${lines.join('\n')}\n`);
process.stdout.write(`${JSON.stringify({ release, candidates: rows.length, output: root })}\n`);
