import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGrokArgs, GrokAdapter } from '../../src/adapters/grok.js';
import type { ChildLike, SpawnFn } from '../../src/adapters/claude.js';
import {
  guardianExecutionPolicyDefaults,
  effectiveRepoExecutionPolicy,
} from '../../src/domain/repoExecutionPolicy.js';
import type { AgentStartInput } from '../../src/orchestrator/adapter.js';

const baseInput: AgentStartInput = {
  taskId: 'T-pol',
  workspace: '/ws/app/T-pol',
  prompt: 'do',
  allocation: { slug: 'T-pol', port: 4100, scratchDir: '/ws/app/T-pol/.scratch' },
};

class FakeChild extends EventEmitter implements ChildLike {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  kill(): boolean {
    return true;
  }
}

describe('Grok argv from execution policy', () => {
  it('guardian: workspace sandbox + disable-web-search', () => {
    const args = buildGrokArgs({
      ...baseInput,
      executionClass: 'implement',
      executionPolicy: guardianExecutionPolicyDefaults(),
    });
    expect(args[args.indexOf('--sandbox') + 1]).toBe('workspace');
    expect(args).toContain('--disable-web-search');
  });

  it('network unrestricted omits disable-web-search', () => {
    const args = buildGrokArgs({
      ...baseInput,
      executionClass: 'implement',
      executionPolicy: effectiveRepoExecutionPolicy({ network: 'unrestricted', sandbox: 'workspace' }),
    });
    expect(args).not.toContain('--disable-web-search');
    expect(args[args.indexOf('--sandbox') + 1]).toBe('workspace');
  });

  it('read-only sandbox is passed through on argv', () => {
    const args = buildGrokArgs({
      ...baseInput,
      executionClass: 'explore',
      executionPolicy: effectiveRepoExecutionPolicy({ sandbox: 'read-only', network: 'off' }),
    });
    expect(args[args.indexOf('--sandbox') + 1]).toBe('read-only');
    expect(args).toContain('--disable-web-search');
  });

  it('guardian implement argv is exact (workspace sandbox + network off)', () => {
    const args = buildGrokArgs({
      ...baseInput,
      executionClass: 'implement',
      executionPolicy: guardianExecutionPolicyDefaults(),
    });
    expect(args).toEqual([
      '-p',
      'do',
      '--output-format',
      'streaming-json',
      '--permission-mode',
      'dontAsk',
      '--sandbox',
      'workspace',
      '--tools',
      'read_file,grep,list_dir,search_replace',
      '--disallowed-tools',
      'run_terminal_command,write',
      '--deny',
      'Bash',
      '--allow',
      'Read',
      '--allow',
      'Grep',
      '--allow',
      'Edit',
      '--disable-web-search',
      '--allow',
      'MCPTool(hercules_workspace__apply_patch)',
      '--allow',
      'MCPTool(hercules_workspace__delete_file)',
      '--cwd',
      '/ws/app/T-pol',
    ]);
  });

  it('read-only sandbox strips every mutation surface (tools, Edit, MCP)', () => {
    const args = buildGrokArgs({
      ...baseInput,
      executionClass: 'implement',
      executionPolicy: effectiveRepoExecutionPolicy({ sandbox: 'read-only', network: 'off' }),
    });
    expect(args[args.indexOf('--sandbox') + 1]).toBe('read-only');
    expect(args[args.indexOf('--tools') + 1]).toBe('read_file,grep,list_dir');
    expect(args[args.indexOf('--disallowed-tools') + 1]).toBe(
      'run_terminal_command,write,search_replace,edit',
    );
    expect(args).not.toContain('Edit');
    expect(args.join(' ')).not.toContain('MCPTool(');
    expect(args).toContain('--disable-web-search');
  });

  it('read-only sandbox does not register the workspace-mutation MCP home', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'hercules-grok-ro-'));
    try {
      const spawn: SpawnFn = () => new FakeChild();
      const start = (policy: ReturnType<typeof effectiveRepoExecutionPolicy>): string => {
        new GrokAdapter({
          spawn,
          operatorGrokHome: join(scratch, 'no-such-operator-home'),
          workspaceMcpServerPath: join(scratch, 'server.js'),
        }).start(
          {
            ...baseInput,
            allocation: { slug: 'T-pol', port: 4100, scratchDir: scratch },
            executionClass: 'implement',
            executionPolicy: policy,
          },
          0,
        );
        return readFileSync(join(scratch, 'grok-home', 'T-pol', 'config.toml'), 'utf8');
      };
      const guardianToml = start(guardianExecutionPolicyDefaults());
      expect(guardianToml).toContain('[mcp_servers.hercules_workspace]');
      const readOnlyToml = start(
        effectiveRepoExecutionPolicy({ sandbox: 'read-only', network: 'off' }),
      );
      expect(readOnlyToml).not.toContain('[mcp_servers.');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('spawn receives policy-filtered env without provider keys for Grok', () => {
    const saved = { ...process.env };
    process.env['XAI_API_KEY'] = 'secret-xai';
    process.env['OPENAI_API_KEY'] = 'secret-oai';
    process.env['DATABASE_URL'] = 'postgres://secret';
    try {
      const envs: (NodeJS.ProcessEnv | undefined)[] = [];
      const spawn: SpawnFn = (_c, _a, o) => {
        envs.push(o.env);
        return new FakeChild();
      };
      new GrokAdapter({ spawn, prepareHome: false }).start(
        { ...baseInput, executionPolicy: guardianExecutionPolicyDefaults() },
        0,
      );
      expect(envs).toHaveLength(1);
      const env = envs[0]!;
      // Grok coding auth is the isolated GROK_HOME path — no provider keys.
      expect(env['XAI_API_KEY']).toBeUndefined();
      expect(env['OPENAI_API_KEY']).toBeUndefined();
      expect(env['DATABASE_URL']).toBeUndefined();
      expect(env['HERCULES_SLUG']).toBe('T-pol');
      expect(env['PORT']).toBe('4100');
      expect(JSON.stringify(env)).not.toContain('secret-xai');
      expect(JSON.stringify(env)).not.toContain('secret-oai');
    } finally {
      process.env = { ...saved } as NodeJS.ProcessEnv;
    }
  });
});
