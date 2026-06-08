import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// CHANGE 5 (custom): per-project OMC agent overrides via a PreToolUse rewrite.
// OMC invokes its agents by the scoped id `oh-my-claudecode:<name>`, which always
// resolves to the bundled prompt. When the current project ships a native override at
// {cwd}/.claude/agents/<name>.md, the hook rewrites subagent_type to the bare <name>
// (permissionDecision: allow + updatedInput) so project-scope precedence wins.

const SCRIPT_PATH = join(process.cwd(), 'scripts', 'pre-tool-enforcer.mjs');
const NODE = process.execPath;

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

interface HookOutput {
  continue?: boolean;
  hookSpecificOutput?: {
    permissionDecision?: string;
    permissionDecisionReason?: string;
    additionalContext?: string;
    updatedInput?: Record<string, unknown>;
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
    },
  }).trim();
  return JSON.parse(raw) as HookOutput;
}

function writeProjectAgent(cwd: string, bareName: string): void {
  const agentsDir = join(cwd, '.claude', 'agents');
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    join(agentsDir, `${bareName}.md`),
    `---\nname: ${bareName}\n---\nProject-local ${bareName} override.\n`,
  );
}

describe('pre-tool-enforcer.mjs — per-project agent override (CHANGE 5)', () => {
  it('rewrites a scoped OMC subagent_type to the bare name when the project ships an override', () => {
    const cwd = makeCwd('pte-agent-override-');
    writeProjectAgent(cwd, 'executor');

    const output = runEnforcer({
      tool_name: 'Task',
      cwd,
      session_id: 'sess-override',
      toolInput: {
        subagent_type: 'oh-my-claudecode:executor',
        description: 'do the work',
        prompt: 'go',
        model: 'opus',
      },
    });

    const hook = output.hookSpecificOutput ?? {};
    expect(output.continue).toBe(true);
    expect(hook.permissionDecision).toBe('allow');
    expect(hook.permissionDecisionReason).toContain('[OMC AGENT OVERRIDE]');
    expect(hook.updatedInput).toBeDefined();
    expect(hook.updatedInput?.subagent_type).toBe('executor');
  });

  it('preserves all other tool-input fields through the rewrite', () => {
    const cwd = makeCwd('pte-agent-override-fields-');
    writeProjectAgent(cwd, 'planner');

    const output = runEnforcer({
      tool_name: 'Agent',
      cwd,
      session_id: 'sess-override-fields',
      toolInput: {
        subagent_type: 'oh-my-claudecode:planner',
        description: 'plan it',
        prompt: 'design the thing',
        model: 'sonnet',
      },
    });

    const updated = output.hookSpecificOutput?.updatedInput ?? {};
    expect(updated.subagent_type).toBe('planner');
    expect(updated.description).toBe('plan it');
    expect(updated.prompt).toBe('design the thing');
    expect(updated.model).toBe('sonnet');
  });

  it('does NOT rewrite when no project override file exists (passes through)', () => {
    const cwd = makeCwd('pte-agent-no-override-');

    const output = runEnforcer({
      tool_name: 'Task',
      cwd,
      session_id: 'sess-no-override',
      toolInput: {
        subagent_type: 'oh-my-claudecode:planner',
        description: 'plan it',
        prompt: 'go',
      },
    });

    const hook = output.hookSpecificOutput ?? {};
    expect(hook.updatedInput).toBeUndefined();
    expect(hook.permissionDecision).not.toBe('allow');
    expect(String(hook.additionalContext)).toContain('Spawning agent: oh-my-claudecode:planner');
  });

  it('does NOT rewrite a bare (non-scoped) subagent_type even if a same-named file exists', () => {
    const cwd = makeCwd('pte-agent-bare-');
    writeProjectAgent(cwd, 'executor');

    const output = runEnforcer({
      tool_name: 'Task',
      cwd,
      session_id: 'sess-bare',
      toolInput: {
        subagent_type: 'executor',
        description: 'do the work',
        prompt: 'go',
      },
    });

    // A bare subagent_type is already project-resolvable; the hook must not touch it.
    expect(output.hookSpecificOutput?.updatedInput).toBeUndefined();
  });

  it('only rewrites the scoped agent that has a matching project override file', () => {
    const cwd = makeCwd('pte-agent-selective-');
    // Project overrides executor but NOT architect.
    writeProjectAgent(cwd, 'executor');

    const architect = runEnforcer({
      tool_name: 'Task',
      cwd,
      session_id: 'sess-selective-architect',
      toolInput: {
        subagent_type: 'oh-my-claudecode:architect',
        description: 'review design',
        prompt: 'go',
      },
    });

    expect(architect.hookSpecificOutput?.updatedInput).toBeUndefined();
    expect(String(architect.hookSpecificOutput?.additionalContext)).toContain(
      'Spawning agent: oh-my-claudecode:architect',
    );
  });
});
