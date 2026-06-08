import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// CHANGE 4 (custom): the ultragoal /goal PreToolUse guard must be satisfiable.
// This Claude Code build does not surface the active /goal in the hook payload, so
// the guard recovers the objective from the TRANSCRIPT ("Goal set: <objective>").
// A matching, uncleared objective ALLOWS tools; a missing / mismatched / cleared
// objective still BLOCKS (enforcement preserved).

const SCRIPT_PATH = join(process.cwd(), 'scripts', 'pre-tool-enforcer.mjs');
const NODE = process.execPath;
const OBJECTIVE = 'complete the aggregate ultragoal';

const tempDirs: string[] = [];

function makeCwd(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
});

function writeJson(filePath: string, data: Record<string, unknown>): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function writeActiveUltragoalState(cwd: string, sessionId: string): void {
  // STATE_STALE_MS is 2h, so last_checked_at must be fresh or the guard treats the
  // state as stale and skips enforcement entirely.
  writeJson(join(cwd, '.omc', 'state', 'sessions', sessionId, 'ultragoal-state.json'), {
    active: true,
    session_id: sessionId,
    project_path: cwd,
    objective: OBJECTIVE,
    last_checked_at: new Date().toISOString(),
  });
}

function writeTranscript(cwd: string, lines: string[]): string {
  const transcriptPath = join(cwd, 'transcript.jsonl');
  const body = lines
    .map((content) => JSON.stringify({ type: 'user', message: { role: 'user', content } }))
    .join('\n');
  writeFileSync(transcriptPath, `${body}\n`, 'utf-8');
  return transcriptPath;
}

interface HookOutput {
  continue?: boolean;
  hookSpecificOutput?: {
    permissionDecision?: string;
    permissionDecisionReason?: string;
    additionalContext?: string;
  };
}

function runEnforcer(input: Record<string, unknown>): HookOutput {
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
  const homeDir = join(cwd, '.test-home');
  const raw = execFileSync(NODE, [SCRIPT_PATH], {
    cwd,
    input: JSON.stringify(input),
    encoding: 'utf-8',
    timeout: 5000,
    env: {
      ...process.env,
      HOME: homeDir,
      CLAUDE_CONFIG_DIR: join(homeDir, '.claude'),
      NODE_ENV: 'test',
      DISABLE_OMC: '',
      OMC_SKIP_HOOKS: '',
      ALLOW_ULTRAGOAL_WITHOUT_GOAL: '',
    },
  }).trim();
  return JSON.parse(raw) as HookOutput;
}

function isBlocked(output: HookOutput): boolean {
  return JSON.stringify(output).includes('[ULTRAGOAL /GOAL REQUIRED]');
}

describe('pre-tool-enforcer.mjs — ultragoal /goal transcript fallback (CHANGE 4)', () => {
  it('BLOCKS when no /goal is recoverable (baseline enforcement, sanity)', () => {
    const cwd = makeCwd('pte-ug-baseline-');
    const sessionId = 'sess-ug-baseline';
    writeActiveUltragoalState(cwd, sessionId);

    const output = runEnforcer({
      tool_name: 'Bash',
      cwd,
      session_id: sessionId,
      tool_input: { command: 'echo safe' },
    });

    expect(isBlocked(output)).toBe(true);
  });

  it('ALLOWS the tool when a matching "Goal set:" is found in the transcript', () => {
    const cwd = makeCwd('pte-ug-allow-');
    const sessionId = 'sess-ug-allow';
    writeActiveUltragoalState(cwd, sessionId);
    const transcriptPath = writeTranscript(cwd, [
      `<local-command-stdout>Goal set: ${OBJECTIVE}</local-command-stdout>`,
    ]);

    const output = runEnforcer({
      tool_name: 'Bash',
      cwd,
      session_id: sessionId,
      transcript_path: transcriptPath,
      tool_input: { command: 'echo safe' },
    });

    expect(isBlocked(output)).toBe(false);
    expect(output.continue).toBe(true);
  });

  it('still BLOCKS when the transcript /goal objective does not match', () => {
    const cwd = makeCwd('pte-ug-mismatch-');
    const sessionId = 'sess-ug-mismatch';
    writeActiveUltragoalState(cwd, sessionId);
    const transcriptPath = writeTranscript(cwd, ['Goal set: something totally unrelated']);

    const output = runEnforcer({
      tool_name: 'Bash',
      cwd,
      session_id: sessionId,
      transcript_path: transcriptPath,
      tool_input: { command: 'echo safe' },
    });

    expect(isBlocked(output)).toBe(true);
  });

  it('still BLOCKS when the matching /goal was later cleared', () => {
    const cwd = makeCwd('pte-ug-cleared-');
    const sessionId = 'sess-ug-cleared';
    writeActiveUltragoalState(cwd, sessionId);
    const transcriptPath = writeTranscript(cwd, [
      `Goal set: ${OBJECTIVE}`,
      'Goal cleared',
    ]);

    const output = runEnforcer({
      tool_name: 'Bash',
      cwd,
      session_id: sessionId,
      transcript_path: transcriptPath,
      tool_input: { command: 'echo safe' },
    });

    expect(isBlocked(output)).toBe(true);
  });

  it('honors the LAST "Goal set:" when the objective is re-set after a clear', () => {
    const cwd = makeCwd('pte-ug-reset-');
    const sessionId = 'sess-ug-reset';
    writeActiveUltragoalState(cwd, sessionId);
    const transcriptPath = writeTranscript(cwd, [
      'Goal set: an earlier unrelated goal',
      'Goal cleared',
      `<local-command-stdout>Goal set: ${OBJECTIVE}</local-command-stdout>`,
    ]);

    const output = runEnforcer({
      tool_name: 'Bash',
      cwd,
      session_id: sessionId,
      transcript_path: transcriptPath,
      tool_input: { command: 'echo safe' },
    });

    expect(isBlocked(output)).toBe(false);
  });
});
