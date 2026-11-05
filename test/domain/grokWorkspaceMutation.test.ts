/**
 * Domain contract: exact Grok tool CSV + permission argv per execution class.
 *
 * Implement mutation is H MCP (hercules_workspace__*), not Grok built-ins.
 * Coding runs strip the real shell tool `run_terminal_command` and deny Bash.
 */
import { describe, it, expect } from 'vitest';
import {
  GROK_CODING_DISALLOWED_TOOLS,
  GROK_EXPLORE_VERIFY_TOOLS,
  GROK_HOST_TOOLS,
  GROK_IMPLEMENT_TOOLS,
  GROK_MCP_APPLY_PATCH_TOOL,
  GROK_MCP_DELETE_FILE_TOOL,
  GROK_READ_ONLY_DISALLOWED_TOOLS,
  GROK_READ_ONLY_TOOLS,
  grokCodingTools,
  grokPermissionArgs,
} from '../../src/domain/executionClass.js';
import {
  assertPatchPathsConfined,
  findForbiddenCodingTool,
  isForbiddenCodingToolName,
} from '../../src/domain/workspaceMutation.js';

describe('Grok tool CSV constants', () => {
  it('implement built-ins exclude shell and built-in apply_patch/delete_file', () => {
    expect(GROK_IMPLEMENT_TOOLS).toBe('read_file,grep,list_dir,search_replace');
    expect(GROK_IMPLEMENT_TOOLS.split(',')).toEqual([
      'read_file',
      'grep',
      'list_dir',
      'search_replace',
    ]);
    expect(GROK_IMPLEMENT_TOOLS).not.toMatch(/run_terminal_command|run_terminal_cmd|apply_patch|delete_file/);
  });

  it('explore/verify stay constrained; host uses real shell tool name only', () => {
    expect(GROK_EXPLORE_VERIFY_TOOLS).toBe('read_file,grep,list_dir,search_replace');
    expect(GROK_EXPLORE_VERIFY_TOOLS).not.toMatch(
      /delete_file|apply_patch|run_terminal_command|run_terminal_cmd/,
    );
    expect(GROK_HOST_TOOLS).toBe('read_file,grep,list_dir,run_terminal_command');
    expect(GROK_HOST_TOOLS).not.toMatch(/search_replace|delete_file|apply_patch|run_terminal_cmd\b/);
    expect(GROK_CODING_DISALLOWED_TOOLS).toBe('run_terminal_command,write');
  });

  it('grokCodingTools maps classes to the exact CSV', () => {
    expect(grokCodingTools('implement')).toBe(GROK_IMPLEMENT_TOOLS);
    expect(grokCodingTools('explore')).toBe(GROK_EXPLORE_VERIFY_TOOLS);
    expect(grokCodingTools('verify')).toBe(GROK_EXPLORE_VERIFY_TOOLS);
  });
});

describe('grokPermissionArgs (controls H owns)', () => {
  it('implement: dontAsk + workspace + MCP mutation allows + shell stripped', () => {
    for (const task of [{}, { executionClass: 'implement' as const }]) {
      const args = grokPermissionArgs(task);
      expect(args).toEqual(
        expect.arrayContaining([
          '--permission-mode',
          'dontAsk',
          '--sandbox',
          'workspace',
          '--tools',
          GROK_IMPLEMENT_TOOLS,
          '--disallowed-tools',
          GROK_CODING_DISALLOWED_TOOLS,
          '--deny',
          'Bash',
          '--disable-web-search',
        ]),
      );
      expect(args[args.indexOf('--tools') + 1]).toBe(GROK_IMPLEMENT_TOOLS);
      expect(args).toContain(`MCPTool(${GROK_MCP_APPLY_PATCH_TOOL})`);
      expect(args).toContain(`MCPTool(${GROK_MCP_DELETE_FILE_TOOL})`);
      // Shell must not be allowed — only denied/disallowed.
      expect(args.join('\n')).not.toMatch(/--allow\nBash\b/);
      expect(args[args.indexOf('--tools') + 1]).not.toMatch(/run_terminal_command/);
    }
  });

  it('explore: no mutation MCP allows; shell still stripped', () => {
    const args = grokPermissionArgs({ executionClass: 'explore' });
    expect(args).toContain('dontAsk');
    expect(args).toContain('workspace');
    expect(args[args.indexOf('--tools') + 1]).toBe(GROK_EXPLORE_VERIFY_TOOLS);
    expect(args).toContain(GROK_CODING_DISALLOWED_TOOLS);
    expect(args).toContain('Bash');
    expect(args.join(' ')).not.toMatch(/MCPTool\(hercules_workspace__/);
    expect(args).toContain('--disable-web-search');
  });

  it('verify: read-only tool surface regardless of repo policy (C3.56)', () => {
    for (const executionPolicy of [null, { sandbox: 'workspace' }] as const) {
      const args = grokPermissionArgs({
        executionClass: 'verify',
        executionPolicy: executionPolicy as never,
      });
      expect(args[args.indexOf('--sandbox') + 1]).toBe('read-only');
      expect(args[args.indexOf('--tools') + 1]).toBe(GROK_READ_ONLY_TOOLS);
      expect(args[args.indexOf('--disallowed-tools') + 1]).toBe(GROK_READ_ONLY_DISALLOWED_TOOLS);
      expect(args).not.toContain('Edit');
      expect(args[args.indexOf('--tools') + 1]).not.toMatch(/search_replace|edit|write/);
      expect(args.join(' ')).not.toMatch(/MCPTool\(hercules_workspace__/);
      expect(args).toContain('Bash');
    }
  });

  it('host_operation: sandbox off + host tools + scoped Bash only', () => {
    const args = grokPermissionArgs({
      executionClass: 'host_operation',
      hostCommandScope: ['systemctl restart hercules'],
    });
    expect(args).toContain('dontAsk');
    expect(args).toContain('off');
    expect(args[args.indexOf('--tools') + 1]).toBe(GROK_HOST_TOOLS);
    expect(args).toContain('Bash(systemctl restart hercules)');
    expect(args.join(' ')).not.toMatch(/search_replace|delete_file|apply_patch|hercules_workspace/);
  });
});

describe('runtime forbidden-tool detection', () => {
  it('flags run_terminal_command and shell aliases', () => {
    expect(isForbiddenCodingToolName('run_terminal_command')).toBe(true);
    expect(isForbiddenCodingToolName('run_terminal_cmd')).toBe(true);
    expect(isForbiddenCodingToolName('Bash')).toBe(true);
    expect(isForbiddenCodingToolName('search_replace')).toBe(false);
    expect(findForbiddenCodingTool(['read_file', 'run_terminal_command'])).toBe(
      'run_terminal_command',
    );
    expect(findForbiddenCodingTool([{ name: 'Bash' }])).toBe('Bash');
    expect(findForbiddenCodingTool(['read_file', 'grep'])).toBeNull();
  });
});

describe('assertPatchPathsConfined', () => {
  it('accepts ordinary relative git paths and rejects traversal/absolute', () => {
    const ok = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1 +1 @@',
      '-a',
      '+b',
    ].join('\n');
    expect(assertPatchPathsConfined(ok)).toEqual(['src/a.ts']);

    expect(() =>
      assertPatchPathsConfined(
        ['diff --git a/../x b/../x', '--- a/../x', '+++ b/../x'].join('\n'),
      ),
    ).toThrow(/traversal/);
    expect(() =>
      assertPatchPathsConfined(
        ['diff --git a//etc/passwd b//etc/passwd', '--- a//etc/passwd', '+++ b//etc/passwd'].join(
          '\n',
        ),
      ),
    ).toThrow(/absolute/);
  });
});
