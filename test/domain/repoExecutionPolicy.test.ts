import { describe, it, expect } from 'vitest';
import {
  compatibleExecutionPolicyDefaults,
  effectiveRepoExecutionPolicy,
  filterChildEnv,
  formatEnvFilterReceipt,
  formatPolicyEnforceFailure,
  formatPolicyCapabilityReceipt,
  guardianExecutionPolicyDefaults,
  policyDiagnostics,
  resolvePolicyAgainstAdapter,
  validateEnvAllowlist,
} from '../../src/domain/repoExecutionPolicy.js';

const SECRET = 'super-secret-value-never-in-receipt';

describe('effectiveRepoExecutionPolicy', () => {
  it('omitted input yields compatible defaults', () => {
    const p = effectiveRepoExecutionPolicy(null);
    expect(p).toEqual(compatibleExecutionPolicyDefaults());
    expect(p.explicit).toBe(false);
    expect(p.sandbox).toBe('none');
    expect(p.network).toBe('unspecified');
    expect(p.workspaceWrite).toBe(false);
    const diag = policyDiagnostics(p);
    expect(diag.explicit).toBe(false);
    expect(diag.profile).toBe('compatible');
    expect(diag.sandbox).toBe('none');
    expect(diag.envAllowlist.length).toBeGreaterThan(0);
  });

  it('guardian profile expands to fail-closed defaults', () => {
    const p = effectiveRepoExecutionPolicy({ profile: 'guardian' });
    expect(p.explicit).toBe(true);
    expect(p.sandbox).toBe('workspace');
    expect(p.network).toBe('off');
    expect(p.workspaceWrite).toBe(true);
  });

  it('field overrides win over profile defaults', () => {
    const p = effectiveRepoExecutionPolicy({
      profile: 'guardian',
      network: 'limited',
      envAllowlist: ['PATH', 'HOME'],
    });
    expect(p.network).toBe('limited');
    expect(p.envAllowlist).toEqual(['PATH', 'HOME']);
  });
});

describe('validateEnvAllowlist', () => {
  it('accepts identifier names and rejects bad ones', () => {
    expect(validateEnvAllowlist(['PATH', 'HOME']).ok).toBe(true);
    expect(validateEnvAllowlist(['bad-name']).ok).toBe(false);
    expect(validateEnvAllowlist(['PATH', 'PATH']).ok).toBe(false);
  });
});

describe('filterChildEnv', () => {
  it('drops secrets and never puts values in the receipt', () => {
    const { env, decision } = filterChildEnv({
      policy: guardianExecutionPolicyDefaults(),
      role: 'coding',
      modelAuthNames: ['XAI_API_KEY'],
      source: {
        PATH: '/usr/bin',
        XAI_API_KEY: SECRET,
        DATABASE_URL: SECRET,
        GITHUB_TOKEN: SECRET,
        HERCULES_TOKEN: SECRET,
        SLACK_BOT_TOKEN: SECRET,
        CUSTOMER_EMAIL: 'a@b.c',
        NODE_OPTIONS: '--require /tmp/evil',
        RANDOM_BUSINESS_VAR: 'x',
      },
    });
    expect(env['PATH']).toBe('/usr/bin');
    expect(env['XAI_API_KEY']).toBe(SECRET);
    expect(env['DATABASE_URL']).toBeUndefined();
    expect(env['GITHUB_TOKEN']).toBeUndefined();
    expect(env['HERCULES_TOKEN']).toBeUndefined();
    expect(env['SLACK_BOT_TOKEN']).toBeUndefined();
    expect(env['CUSTOMER_EMAIL']).toBeUndefined();
    expect(env['NODE_OPTIONS']).toBeUndefined();
    const receipt = formatEnvFilterReceipt(decision);
    expect(receipt).toContain('DATABASE_URL');
    expect(receipt).not.toContain(SECRET);
    expect(JSON.stringify(decision)).not.toContain(SECRET);
  });

  it('withholds model-auth unless requested', () => {
    const { env } = filterChildEnv({
      policy: compatibleExecutionPolicyDefaults(),
      role: 'verification',
      source: { PATH: '/bin', XAI_API_KEY: SECRET },
    });
    expect(env['XAI_API_KEY']).toBeUndefined();
  });

  it('modelAuthNames is intersected with the canonical model-auth set', () => {
    const { env, decision } = filterChildEnv({
      policy: guardianExecutionPolicyDefaults(),
      role: 'coding',
      // DATABASE_URL riding in modelAuthNames must not bypass prohibition.
      modelAuthNames: ['DATABASE_URL', 'ANTHROPIC_API_KEY'],
      source: { PATH: '/bin', DATABASE_URL: SECRET, ANTHROPIC_API_KEY: SECRET },
    });
    expect(env['DATABASE_URL']).toBeUndefined();
    expect(env['ANTHROPIC_API_KEY']).toBe(SECRET);
    expect(decision.modelAuth).toEqual(['ANTHROPIC_API_KEY']);
    expect(JSON.stringify(decision)).not.toContain(SECRET);
  });

  it('explicit policy does not widen via NODE_ prefixes', () => {
    const policy = effectiveRepoExecutionPolicy({ profile: 'guardian', envAllowlist: ['PATH'] });
    const { env } = filterChildEnv({
      policy,
      role: 'coding',
      modelAuthNames: [],
      source: { PATH: '/bin', NODE_ENV: 'test' },
    });
    expect(env['PATH']).toBe('/bin');
    expect(env['NODE_ENV']).toBeUndefined();
  });
});

describe('resolvePolicyAgainstAdapter', () => {
  it('compatible defaults allow every coding adapter', () => {
    const policy = compatibleExecutionPolicyDefaults();
    for (const kind of ['grok', 'codex', 'claude', 'cursor', 'fake'] as const) {
      expect(resolvePolicyAgainstAdapter(kind, policy).ok).toBe(true);
    }
  });

  it('guardian fails closed for codex/claude; grok/fake ok', () => {
    const policy = guardianExecutionPolicyDefaults();
    expect(resolvePolicyAgainstAdapter('grok', policy).ok).toBe(true);
    expect(resolvePolicyAgainstAdapter('fake', policy).ok).toBe(true);
    const codex = resolvePolicyAgainstAdapter('codex', policy);
    expect(codex.ok).toBe(false);
    if (!codex.ok) {
      expect(formatPolicyEnforceFailure(codex)).toMatch(/blocked dispatch/);
      expect(codex.reason).toMatch(/codex/);
      const receipt = formatPolicyCapabilityReceipt({
        adapter: 'codex',
        result: codex,
        stamp: '2026-08-07T00:00:00.000Z',
      });
      expect(receipt).toMatch(/Adapter capability receipt/);
      expect(receipt).toMatch(/sandbox_unsupported|capability gap|blocked/i);
      expect(receipt).not.toMatch(/token=/i);
    }
    expect(resolvePolicyAgainstAdapter('claude', policy).ok).toBe(false);
    expect(resolvePolicyAgainstAdapter('cursor', policy).ok).toBe(false);
  });

  it('network-off unsupported stops before agent execution', () => {
    const policy = effectiveRepoExecutionPolicy({
      network: 'off',
      sandbox: 'none',
      workspaceWrite: false,
    });
    expect(resolvePolicyAgainstAdapter('grok', policy).ok).toBe(true);
    expect(resolvePolicyAgainstAdapter('fake', policy).ok).toBe(true);
    const codex = resolvePolicyAgainstAdapter('codex', policy);
    expect(codex.ok).toBe(false);
    if (!codex.ok) {
      expect(codex.code).toBe('network_unsupported');
    }
    expect(resolvePolicyAgainstAdapter('claude', policy).ok).toBe(false);
  });

  it('workspace-write requirement fails closed for codex/claude', () => {
    const policy = effectiveRepoExecutionPolicy({
      sandbox: 'workspace',
      network: 'unspecified',
      workspaceWrite: true,
    });
    expect(resolvePolicyAgainstAdapter('grok', policy).ok).toBe(true);
    expect(resolvePolicyAgainstAdapter('codex', policy).ok).toBe(false);
    expect(resolvePolicyAgainstAdapter('claude', policy).ok).toBe(false);
  });

  it('workspace_write with non-workspace sandbox fails closed', () => {
    const policy = effectiveRepoExecutionPolicy({ sandbox: 'none', workspaceWrite: true });
    const r = resolvePolicyAgainstAdapter('grok', policy);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('workspace_write_inconsistent');
  });

  it('guardian with relaxed forbid flags fails closed', () => {
    const policy = effectiveRepoExecutionPolicy({ profile: 'guardian', forbidProductionSecrets: false });
    const r = resolvePolicyAgainstAdapter('grok', policy);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('guardian_relaxed');
  });

  it('guardian must keep the full posture — relaxed sandbox/network/workspace_write fail closed', () => {
    for (const relaxed of [
      { sandbox: 'off' },
      { sandbox: 'none' },
      { network: 'unrestricted' },
      { network: 'limited' },
      { workspaceWrite: false },
    ] as const) {
      const policy = effectiveRepoExecutionPolicy({ profile: 'guardian', ...relaxed });
      const r = resolvePolicyAgainstAdapter('grok', policy);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('guardian_relaxed');
    }
  });

  it('workspace_write with read-only sandbox is contradictory and fails closed', () => {
    const policy = effectiveRepoExecutionPolicy({ sandbox: 'read-only', workspaceWrite: true });
    const r = resolvePolicyAgainstAdapter('grok', policy);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('workspace_write_inconsistent');
  });
});
