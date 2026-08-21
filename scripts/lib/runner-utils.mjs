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
