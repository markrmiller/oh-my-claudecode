import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// Guard hardening for the ultragoal /goal PreToolUse enforcement:
//   Fix A — never block when there is no derivable objective (un-satisfiable guard).
//   Fix B — never block the documented cancel / state-management escape hatch
//           (ToolSearch, Skill:cancel, state_* MCP tools, cancel's bash fallback).
// Ordinary tools with a real objective and no matching /goal still BLOCK.

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

// Fresh last_checked_at so the state is NOT treated as stale (STATE_STALE_MS = 2h).
function writeActiveUltragoalState(
  cwd: string,
  sessionId: string,
  extra: Record<string, unknown>,
): void {
  writeJson(join(cwd, '.omc', 'state', 'sessions', sessionId, 'ultragoal-state.json'), {
    active: true,
    session_id: sessionId,
    project_path: cwd,
    last_checked_at: new Date().toISOString(),
    ...extra,
  });
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

describe('pre-tool-enforcer.mjs — ultragoal guard hardening', () => {
  describe('Fix A: empty/un-derivable objective never blocks', () => {
    it('does NOT block a Bash call when state has only original_prompt and no objective/goals.json', () => {
      const cwd = makeCwd('pte-ug-empty-');
      const sessionId = 'sess-ug-empty';
      writeActiveUltragoalState(cwd, sessionId, {
        original_prompt: 'keyword-activated ultragoal with no objective recorded',
      });

      const output = runEnforcer({
        tool_name: 'Bash',
        cwd,
        session_id: sessionId,
        tool_input: { command: 'echo safe' },
      });

      expect(isBlocked(output)).toBe(false);
    });
  });

  describe('Fix B: cancellation / state escape hatch is never blocked', () => {
    it('does NOT block a ToolSearch call (cancel needs it to load state tools)', () => {
      const cwd = makeCwd('pte-ug-toolsearch-');
      const sessionId = 'sess-ug-toolsearch';
      writeActiveUltragoalState(cwd, sessionId, { objective: OBJECTIVE });

      const output = runEnforcer({
        tool_name: 'ToolSearch',
        cwd,
        session_id: sessionId,
        tool_input: { query: 'select:state_clear' },
      });

      expect(isBlocked(output)).toBe(false);
    });

    it('does NOT block a Skill call for the cancel skill', () => {
      const cwd = makeCwd('pte-ug-cancel-');
      const sessionId = 'sess-ug-cancel';
      writeActiveUltragoalState(cwd, sessionId, { objective: OBJECTIVE });

      const output = runEnforcer({
        tool_name: 'Skill',
        cwd,
        session_id: sessionId,
        tool_input: { skill_name: 'cancel' },
      });

      expect(isBlocked(output)).toBe(false);
    });

    it('does NOT block a state_clear MCP tool call', () => {
      const cwd = makeCwd('pte-ug-stateclear-');
      const sessionId = 'sess-ug-stateclear';
      writeActiveUltragoalState(cwd, sessionId, { objective: OBJECTIVE });

      const output = runEnforcer({
        tool_name: 'mcp__plugin_oh-my-claudecode_t__state_clear',
        cwd,
        session_id: sessionId,
        tool_input: { mode: 'ultragoal' },
      });

      expect(isBlocked(output)).toBe(false);
    });

    it('STILL blocks an ordinary Bash call (guard otherwise intact)', () => {
      const cwd = makeCwd('pte-ug-blocked-');
      const sessionId = 'sess-ug-blocked';
      writeActiveUltragoalState(cwd, sessionId, { objective: OBJECTIVE });

      const output = runEnforcer({
        tool_name: 'Bash',
        cwd,
        session_id: sessionId,
        tool_input: { command: 'echo safe' },
      });

      expect(isBlocked(output)).toBe(true);
    });
  });
});
