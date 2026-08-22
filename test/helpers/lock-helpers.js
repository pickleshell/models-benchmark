import { readFileSync } from 'node:fs';
import os from 'node:os';

let clkTck = null;

function getClkTck() {
  if (clkTck !== null) return clkTck;
  try {
    const { spawnSync } = require('node:child_process');
    const result = spawnSync('getconf', ['CLK_TCK'], { encoding: 'utf8' });
    if (result.status === 0 && result.stdout.trim()) {
      clkTck = parseInt(result.stdout.trim(), 10);
      if (clkTck > 0) return clkTck;
    }
  } catch {
    // fallback
  }
  clkTck = 100;
  return clkTck;
}

function getProcessStartTime(pid) {
  try {
    const statPath = `/proc/${pid}/stat`;
    const stat = readFileSync(statPath, 'utf8');
    const fields = stat.split(' ');
    const startTimeTicks = parseInt(fields[21], 10);
    const bootTime = Date.now() - os.uptime() * 1000;
    const clkTck = getClkTck();
    const startTime = bootTime + (startTimeTicks / clkTck) * 1000;
    return startTime;
  } catch {
    return null;
  }
}

export function getCurrentProcessStartTime() {
  return getProcessStartTime(process.pid);
}