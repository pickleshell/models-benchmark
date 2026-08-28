export function parsePorcelainPaths(output) {
  const fields = output.split('\0').filter(Boolean);
  const paths = [];
  for (let index = 0; index < fields.length; index += 1) {
    const entry = fields[index];
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2);
    paths.push(entry.slice(3));
    if ((status[0] === 'R' || status[0] === 'C' || status[1] === 'R' || status[1] === 'C') && fields[index + 1]) {
      paths.push(fields[++index]);
    }
  }
  return [...new Set(paths)].sort();
}

export function findForbiddenChanges(paths, allowedChanges) {
  return paths.filter((file) => !allowedChanges.some((allowed) => file === allowed || file.startsWith(`${allowed}/`)));
}

export function validateJudgePayload(value, criteria) {
  if (!value || typeof value !== 'object' || !value.scores || typeof value.scores !== 'object') return null;
  const scores = {};
  for (const criterion of criteria) {
    const score = value.scores[criterion];
    if (!Number.isFinite(score) || score < 1 || score > 10) return null;
    scores[criterion] = score;
  }
  return { ...value, scores };
}

export function classifyOutcome({ agent, tests, forbiddenChanges }) {
  if (agent.status !== 0 || agent.timed_out || agent.output_limited) return 'agent_failure';
  if (forbiddenChanges.length) return 'forbidden_changes';
  if (tests.status !== 0 || tests.timed_out || tests.output_limited) return 'tests_failed';
  return 'completed';
}

// A successful process exit is not enough: OpenCode can print a human-readable
// provider diagnostic before its JSON error events. Candidates are invoked in
// JSON mode, so availability requires a recognised JSON response event.
export function hasModelResponse(output, agent = 'opencode') {
  let hasText = false;
  let hasError = false;
  for (const line of String(output || '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === 'error') hasError = true;
      if (event.type === 'text' && typeof event.part?.text === 'string' && event.part.text.trim()) hasText = true;
      if (event.type === 'agent_message' && typeof event.text === 'string' && event.text.trim()) hasText = true;
      if (event.type === 'response.output_text' && typeof event.text === 'string' && event.text.trim()) hasText = true;
      if (event.type === 'message' && typeof event.text === 'string' && event.text.trim()) hasText = true;
    } catch {}
  }
  if (agent === 'opencode') return hasText && !hasError;
  // Codex does not use OpenCode's JSON protocol in this runner. Its process
  // status remains authoritative, but a structured error still fails closed.
  return !hasError && (hasText || String(output || '').trim().length > 0);
}

export function createBoundedCollector(limitBytes) {
  const chunks = [];
  let size = 0;
  let limited = false;
  return {
    append(chunk) {
      if (limited) return false;
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = limitBytes - size;
      if (remaining <= 0) {
        limited = true;
        return false;
      }
      if (value.length > remaining) {
        chunks.push(value.subarray(0, remaining));
        size += remaining;
        limited = true;
        return false;
      }
      chunks.push(value);
      size += value.length;
      return true;
    },
    get limited() { return limited; },
    text() { return Buffer.concat(chunks).toString(); }
  };
}


export function summarizeModelUsage(output, agent = 'opencode') {
  if (agent !== 'opencode') {
    return {
      source: 'provider_not_reported',
      reported_cost_usd: null,
      steps: null,
      tokens: { input: null, output: null, reasoning: null, cache_read: null, cache_write: null, total: null }
    };
  }
  let reportedCostUsd = 0;
  let sawCost = false;
  let steps = 0;
  const tokens = { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0, total: 0 };
  for (const line of String(output || '').split('\n')) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const part = event?.part ?? {};
    if (event?.type !== 'step_finish' && part?.type !== 'step-finish') continue;
    steps += 1;
    const cost = Number(part.cost);
    if (Number.isFinite(cost)) {
      reportedCostUsd += cost;
      sawCost = true;
    }
    const t = part.tokens ?? {};
    for (const key of ['input', 'output', 'reasoning', 'total']) {
      const value = Number(t[key]);
      if (Number.isFinite(value)) tokens[key] += value;
    }
    const cache = t.cache ?? {};
    const cacheRead = Number(cache.read);
    const cacheWrite = Number(cache.write);
    if (Number.isFinite(cacheRead)) tokens.cache_read += cacheRead;
    if (Number.isFinite(cacheWrite)) tokens.cache_write += cacheWrite;
  }
  return {
    source: 'opencode_step_finish',
    reported_cost_usd: sawCost ? Number(reportedCostUsd.toFixed(12)) : null,
    steps,
    tokens
  };
}
