#!/usr/bin/env node
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  CANONICAL_JUDGE_IDS, EXPERT_TEMPLATE, appendTelemetry, assertBlindPromptSafe,
  canonicalJudgeNeedsFallback, expertReviewPath, materializeReleaseConfig, planReleaseConfig,
  inspectFinalTelemetry, readJsonIfExists, shouldAdvanceQueue, telemetryRecord, validateExpertReview, validateQueue
} from './lib/phase2-queue.mjs';
import { buildJudgePromptWithHash } from './lib/blind-judging.mjs';
import { computeFileHash } from './lib/artifact-hash.mjs';

const repo = path.resolve(new URL('..', import.meta.url).pathname);
const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const statusOnly = argv.includes('--status');
const retryJudges = argv.includes('--retry-failed-judges');
const stopAfterCurrent = argv.includes('--stop-after-current');
const value = (name) => argv.includes(name) ? argv[argv.indexOf(name) + 1] : null;
const queuePath = path.resolve(value('--queue') ?? path.join(repo, 'config/phase2-v2-queue.json'));
const queue = JSON.parse(await readFile(queuePath, 'utf8'));
validateQueue(queue);
const basePath = path.resolve(repo, queue.base_config);
const base = JSON.parse(await readFile(basePath, 'utf8'));
const canonicalPolicy = JSON.parse(await readFile(path.join(repo, 'config/phase2-v2.json'), 'utf8'));
const releases = readdirSync(path.join(repo, 'config')).map((file) => file.replace(/\.json$/, '')).filter((name) => name.startsWith('phase2-v2-r'));
const output = (event, data = {}) => process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), event, ...data })}\n`);
const run = (command, args, env = process.env) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: repo, env, stdio: 'inherit' });
  child.on('error', reject); child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`${path.basename(command)} exited ${code}`)));
});
const runExit = (command, args, env = process.env) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: repo, env, stdio: 'inherit' });
  child.on('error', reject); child.on('close', resolve);
});
function configFor(candidate) {
  const existingConfigs = releases.map((release) => ({ release, file: path.join(repo, 'config', `${release}.json`) }))
    .filter(({ file }) => existsSync(file))
    .map(({ release, file }) => ({ release, file, config: JSON.parse(readFileSync(file, 'utf8')) }));
  return planReleaseConfig({ releases, existingConfigs, base, candidate, canonicalPolicy, configDirectory: path.join(repo, 'config') });
}
function artifactRoot(config, candidate) { return path.join(config.models_test, config.results_dir, config.release, candidate.id, 'patch', 'attempts', 'attempt-1'); }
async function candidateFinished(config, candidate) { return readJsonIfExists(path.join(artifactRoot(config, candidate), 'run.json')); }
function telemetryPath(config, candidate) { return path.join(repo, 'annotations', config.release, candidate.id, 'patch.attempt-1.telemetry.jsonl'); }
async function finalTelemetry(config, candidate) {
  return inspectFinalTelemetry(telemetryPath(config, candidate), { release: config.release, candidate: candidate.id });
}
async function runFallback(config, candidate, runArtifact, judgeArtifact) {
  const judge = config.judges.find((entry) => entry.id === judgeArtifact.judge.id);
  const root = artifactRoot(config, candidate);
  const task = config.nominations.find((entry) => entry.id === 'patch');
  const instructions = await readFile(path.join(config.models_test, task.prompt), 'utf8');
  const { prompt } = await buildJudgePromptWithHash({ taskId: 'patch', taskInstructions: instructions, criteria: config.criteria, candidateResult: runArtifact });
  assertBlindPromptSafe(prompt, [candidate.id, candidate.model, JSON.stringify(runArtifact.objective_evaluator), 'ChatGPT']);
  const outDir = path.join(repo, 'external-judges', config.release, 'patch');
  const artifactTag = `${judge.id}--${candidate.id}`;
  // The shell helper's tag becomes part of the sandboxed HOME path. Keep it
  // opaque so the blind judge never receives candidate identity by pathname.
  const sandboxTag = `blind-${createHash('sha256').update(`${config.release}:${judge.id}:${candidate.id}`).digest('hex').slice(0, 20)}`;
  const promptFile = path.join(outDir, `${artifactTag}.blind-prompt-v3.txt`);
  const outputFile = path.join(outDir, `${artifactTag}.json`);
  await mkdir(outDir, { recursive: true });
  if (existsSync(promptFile) && await readFile(promptFile, 'utf8') !== `${prompt}\n`) throw new Error(`frozen blind prompt differs: ${promptFile}`);
  if (!existsSync(promptFile)) await writeFile(promptFile, `${prompt}\n`);
  if (!existsSync(outputFile)) await run(path.join(repo, 'scripts/external-blind-review.sh'), [judge.model, sandboxTag, path.join(root, 'candidate.diff'), promptFile, outputFile]);
  const fallback = await readJsonIfExists(outputFile);
  return {
    judge: judge.id,
    kind: 'external_blind_review',
    status: fallback?.payload?.scores ? 'completed' : 'failed',
    preflight: fallback?.preflight ?? null,
    review: fallback?.review ?? null,
    cost_usd: fallback?.review?.usage?.reported_cost_usd ?? null,
    artifact: { path: path.relative(repo, outputFile), sha256: await computeFileHash(outputFile) },
    notes: fallback?.notes ?? ['Fallback produced no score.']
  };
}

async function selectCandidate(requestedCandidate) {
  if (requestedCandidate) return queue.candidates.find((item) => item.id === requestedCandidate) ?? null;
  for (const item of queue.candidates) {
    const planned = configFor(item);
    if (!(await finalTelemetry(planned.config, item)).complete) return item;
  }
  return null;
}
async function advanceOrStop(candidate) {
  const next = queue.candidates[queue.candidates.indexOf(candidate) + 1];
  if (next && shouldAdvanceQueue({ retryJudges, stopAfterCurrent })) {
    output('advancing_queue', { from: candidate.id, to: next.id });
    const exitCode = await runExit(process.execPath, [path.join(repo, 'scripts/run-phase2-queue.mjs')]);
    if (exitCode === 2) process.exitCode = 2; // The next candidate is correctly awaiting an operator review.
    else if (exitCode !== 0) throw new Error(`next queue item failed with exit ${exitCode}`);
  } else if (next && stopAfterCurrent) {
    output('queue_stopped_after_current', { candidate: candidate.id, next_candidate: next.id });
  }
}

const requestedCandidate = value('--candidate');
const candidate = await selectCandidate(requestedCandidate);
if (!candidate) { output('queue_complete', { queue: queuePath }); process.exit(0); }
const planned = configFor(candidate);
const completedTelemetry = await finalTelemetry(planned.config, candidate);
if (dryRun) { output('dry_run', { release: planned.release, candidate, nomination: 'patch', action: completedTelemetry.complete ? 'already complete' : planned.exists ? 'resume existing immutable release' : 'create immutable release then candidate flow', queue_remaining: queue.candidates.map((item) => item.id) }); process.exit(0); }
if (statusOnly) { output('status', { release: planned.release, candidate: candidate.id, candidate_completed: Boolean(await candidateFinished(planned.config, candidate)), telemetry_completed: completedTelemetry.complete, expert_review: expertReviewPath(repo, planned.release, candidate.id) }); process.exit(0); }
if (completedTelemetry.complete) {
  output('model_already_complete', { release: planned.release, candidate: candidate.id, telemetry: completedTelemetry.path, next_candidate: queue.candidates[queue.candidates.indexOf(candidate) + 1]?.id ?? null });
  await advanceOrStop(candidate);
  process.exit();
}
if (await materializeReleaseConfig(planned)) {
  output('release_created', { release: planned.release, config: planned.file });
}
const config = planned.config;
const configEnv = { ...process.env, BENCHMARK_CONFIG: planned.file };
let runArtifact = await candidateFinished(config, candidate);
if (!runArtifact && !retryJudges) {
  await run(process.execPath, [path.join(repo, 'scripts/run-pilot.mjs'), '--phase', 'candidates', '--nomination', 'patch', '--candidate', candidate.id, '--resume'], configEnv);
  runArtifact = await candidateFinished(config, candidate);
}
if (!runArtifact) throw new Error(`missing frozen candidate artifact for ${planned.release}/${candidate.id}`);
if (runArtifact.outcome === 'unavailable') {
  const preflight = await readJsonIfExists(path.join(config.models_test, config.results_dir, config.release, candidate.id, 'preflight.json'));
  const annotation = telemetryPath(config, candidate);
  await mkdir(path.dirname(annotation), { recursive: true });
  await appendTelemetry(annotation, telemetryRecord({ release: config.release, candidate, preflight, run: runArtifact, judges: [], fallbackAttempts: [] }));
  output('model_unavailable_complete', { release: config.release, candidate: candidate.id, outcome: runArtifact.outcome, telemetry: annotation, next_candidate: queue.candidates[queue.candidates.indexOf(candidate) + 1]?.id ?? null });
  await advanceOrStop(candidate);
  process.exit();
}
const reviewFile = value('--expert-review') ? path.resolve(value('--expert-review')) : expertReviewPath(repo, config.release, candidate.id);
const review = await readJsonIfExists(reviewFile);
if (!review) {
  output('WAITING_FOR_EXPERT_REVIEW', { release: config.release, candidate: candidate.id, path: reviewFile, template: EXPERT_TEMPLATE, resume_command: `node scripts/run-phase2-queue.mjs --candidate ${candidate.id}` });
  process.exitCode = 2;
  process.exit();
}
validateExpertReview(review, { release: config.release, candidate: candidate.id, criteria: config.criteria, canonicalExpert: config.canonical_expert_review?.reviewer ?? null });
if (!retryJudges) await run(process.execPath, [path.join(repo, 'scripts/run-pilot.mjs'), '--phase', 'judges', '--nomination', 'patch', '--candidate', candidate.id, '--resume'], configEnv);
const root = artifactRoot(config, candidate);
const judges = await Promise.all(CANONICAL_JUDGE_IDS.map((id) => readJsonIfExists(path.join(root, 'judges', `${id}.json`))));
const objectiveEvidence = runArtifact.artifacts?.objective_evaluator?.path;
const objectiveArtifact = objectiveEvidence ? await readJsonIfExists(path.join(root, objectiveEvidence)) : null;
const fallbacks = [];
for (const artifact of judges) if (canonicalJudgeNeedsFallback(artifact)) fallbacks.push(await runFallback(config, candidate, runArtifact, artifact));
const preflight = await readJsonIfExists(path.join(config.models_test, config.results_dir, config.release, candidate.id, 'preflight.json'));
const annotation = telemetryPath(config, candidate);
await mkdir(path.dirname(annotation), { recursive: true });
await appendTelemetry(annotation, telemetryRecord({ release: config.release, candidate, preflight, run: { ...runArtifact, objective_evaluator: objectiveArtifact }, judges: judges.filter(Boolean), fallbackAttempts: fallbacks }));
output('model_complete', { release: config.release, candidate: candidate.id, telemetry: annotation, next_candidate: queue.candidates[queue.candidates.indexOf(candidate) + 1]?.id ?? null });
await advanceOrStop(candidate);
