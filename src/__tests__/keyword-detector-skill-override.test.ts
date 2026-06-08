import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// CHANGE 3 (custom): a project may ship OMC skill overrides at
//   {root}/.claude/omc-skills/{name}/SKILL.md
// When such an override exists, the keyword detector must steer the model to the
// UNQUALIFIED `/{skill}` slash form (so Claude Code resolves the project override)
// instead of the bundled `/oh-my-claudecode:{skill}` scoped form.

const SCRIPT_PATH = join(process.cwd(), 'scripts', 'keyword-detector.mjs');
const NODE = process.execPath;
const PLUGIN_ROOT = process.cwd(); // repo root ships bundled skills/<name>/SKILL.md

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

function runDetector(prompt: string, cwd: string): string {
  const raw = execFileSync(NODE, [SCRIPT_PATH], {
    input: JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      cwd,
      session_id: 'sess-skill-override',
      prompt,
    }),
    encoding: 'utf-8',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      OMC_SKIP_HOOKS: '',
      // getProjectOverrideRoots() reads these; pin them to the temp project so the
      // inherited repo-root PWD cannot leak in as an override candidate.
      CLAUDE_PROJECT_DIR: cwd,
      PWD: cwd,
      // Bundled skills resolve from the plugin root so the no-override case finds a
      // non-project SKILL.md and emits the scoped form.
      CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
    },
    timeout: 15000,
  }).trim();

  const output = JSON.parse(raw) as {
    hookSpecificOutput?: { additionalContext?: string };
  };
  return output.hookSpecificOutput?.additionalContext ?? '';
}

function writeProjectSkillOverride(cwd: string, skillName: string): string {
  const skillDir = join(cwd, '.claude', 'omc-skills', skillName);
  mkdirSync(skillDir, { recursive: true });
  const skillPath = join(skillDir, 'SKILL.md');
  writeFileSync(skillPath, `# ${skillName} (project override)\n\nProject-local override body.\n`);
  return skillPath;
}

describe('keyword-detector.mjs — project OMC skill overrides (CHANGE 3)', () => {
  it('emits the SCOPED invocation when no project override exists', () => {
    const cwd = makeCwd('kd-skill-no-override-');

    const context = runDetector('ccg this feature', cwd);

    expect(context).toContain('Preferred invocation: /oh-my-claudecode:ccg');
    expect(context).not.toContain('Preferred invocation: /ccg\n');
  });

  it('emits the UNQUALIFIED invocation when the project ships a .claude/omc-skills override', () => {
    const cwd = makeCwd('kd-skill-override-');
    const skillPath = writeProjectSkillOverride(cwd, 'ccg');

    const context = runDetector('ccg this feature', cwd);

    expect(context).toContain('Preferred invocation: /ccg');
    expect(context).not.toContain('Preferred invocation: /oh-my-claudecode:ccg');
    // The read-fallback path should point at the project override file, not a bundled one.
    expect(context).toContain(skillPath);
  });

  it('routes the read-fallback to the project override SKILL.md path', () => {
    const cwd = makeCwd('kd-skill-override-fallback-');
    const skillPath = writeProjectSkillOverride(cwd, 'deep-interview');

    const context = runDetector('deep interview me about this project', cwd);

    expect(context).toContain('Preferred invocation: /deep-interview');
    expect(context).toContain(`Read fallback: open ${skillPath}`);
  });

  it('does not treat a same-named override in an UNRELATED directory as this project override', () => {
    const cwd = makeCwd('kd-skill-unrelated-');
    const other = makeCwd('kd-skill-unrelated-other-');
    // Override lives under a different project root entirely — must be ignored.
    writeProjectSkillOverride(other, 'ccg');

    const context = runDetector('ccg this feature', cwd);

    expect(context).toContain('Preferred invocation: /oh-my-claudecode:ccg');
  });
});
