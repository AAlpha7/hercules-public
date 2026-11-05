import { describe, it, expect } from 'vitest';
import {
  bootChildEnv,
  codingChildEnv,
  reviewChildEnv,
  verificationChildEnv,
} from '../../src/adapters/policyEnv.js';
import {
  effectiveRepoExecutionPolicy,
  guardianExecutionPolicyDefaults,
  modelAuthNamesFor,
} from '../../src/domain/repoExecutionPolicy.js';

const SECRET = 'never-leak-this-value';

describe('codingChildEnv', () => {
  it('blocks secrets and keeps allowlisted names; model-auth is deliberate', () => {
    const { env, decision } = codingChildEnv({
      policy: guardianExecutionPolicyDefaults(),
      modelAuthNames: modelAuthNamesFor('xai'),
      source: {
        PATH: '/usr/bin',
        HOME: '/home/u',
        XAI_API_KEY: SECRET,
        OPENAI_API_KEY: SECRET,
        DATABASE_URL: SECRET,
        GITHUB_TOKEN: SECRET,
        HERCULES_TOKEN: SECRET,
        CUSTOMER_EMAIL: 'a@b.c',
        SLACK_BOT_TOKEN: SECRET,
        NODE_OPTIONS: '--require /tmp/x',
      },
      extras: { HERCULES_SLUG: 't', HERCULES_TASK_ID: 'task-t', PORT: '4100' },
    });
    expect(env['PATH']).toBe('/usr/bin');
    expect(env['XAI_API_KEY']).toBe(SECRET);
    expect(env['OPENAI_API_KEY']).toBeUndefined();
    expect(env['HERCULES_SLUG']).toBe('t');
    expect(env['HERCULES_TASK_ID']).toBe('task-t');
    expect(env['PORT']).toBe('4100');
    expect(env['DATABASE_URL']).toBeUndefined();
    expect(env['GITHUB_TOKEN']).toBeUndefined();
    expect(env['HERCULES_TOKEN']).toBeUndefined();
    expect(env['CUSTOMER_EMAIL']).toBeUndefined();
    expect(env['SLACK_BOT_TOKEN']).toBeUndefined();
    expect(env['NODE_OPTIONS']).toBeUndefined();
    expect(JSON.stringify(decision)).not.toContain(SECRET);
  });

  it('extras cannot re-add prohibited names', () => {
    const { env } = codingChildEnv({
      policy: guardianExecutionPolicyDefaults(),
      modelAuthNames: [],
      source: { PATH: '/bin' },
      extras: { DATABASE_URL: SECRET, HERCULES_TOKEN: SECRET, HERCULES_SLUG: 'ok' },
    });
    expect(env['DATABASE_URL']).toBeUndefined();
    expect(env['HERCULES_TOKEN']).toBeUndefined();
    expect(env['HERCULES_SLUG']).toBe('ok');
  });

  it('explicit env_allowlist is authoritative (no NODE_ prefix widening)', () => {
    const policy = effectiveRepoExecutionPolicy({
      profile: 'guardian',
      envAllowlist: ['PATH', 'HOME'],
    });
    const { env } = codingChildEnv({
      policy,
      modelAuthNames: [],
      source: { PATH: '/bin', HOME: '/h', NODE_ENV: 'test', NODE_EXTRA: 'x' },
    });
    expect(env['PATH']).toBe('/bin');
    expect(env['HOME']).toBe('/h');
    expect(env['NODE_ENV']).toBeUndefined();
    expect(env['NODE_EXTRA']).toBeUndefined();
  });

  it('modelAuthNames cannot smuggle a non-canonical name past the filter', () => {
    // Regression: DATABASE_URL in modelAuthNames must NOT bypass
    // prohibitedEnvReason — only canonical MODEL_AUTH_ENV_NAMES may pass.
    const { env, decision } = codingChildEnv({
      policy: guardianExecutionPolicyDefaults(),
      modelAuthNames: ['DATABASE_URL', 'GITHUB_TOKEN', 'XAI_API_KEY'],
      source: {
        PATH: '/bin',
        DATABASE_URL: SECRET,
        GITHUB_TOKEN: SECRET,
        XAI_API_KEY: SECRET,
      },
    });
    expect(env['DATABASE_URL']).toBeUndefined();
    expect(env['GITHUB_TOKEN']).toBeUndefined();
    expect(env['XAI_API_KEY']).toBe(SECRET);
    expect(decision.modelAuth).toEqual(['XAI_API_KEY']);
    expect(decision.dropped).toContainEqual({ name: 'DATABASE_URL', reason: 'production_secret' });
    expect(JSON.stringify(decision)).not.toContain(SECRET);
  });

  it('Grok coding path requests no provider API keys', () => {
    const { env } = codingChildEnv({
      policy: guardianExecutionPolicyDefaults(),
      modelAuthNames: [],
      source: {
        PATH: '/bin',
        XAI_API_KEY: SECRET,
        OPENAI_API_KEY: SECRET,
        ANTHROPIC_API_KEY: SECRET,
      },
    });
    expect(env['XAI_API_KEY']).toBeUndefined();
    expect(env['OPENAI_API_KEY']).toBeUndefined();
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
  });
});

describe('verificationChildEnv', () => {
  it('never passes model-auth or secrets into gate children', () => {
    const { env } = verificationChildEnv({
      policy: guardianExecutionPolicyDefaults(),
      source: {
        PATH: '/bin',
        XAI_API_KEY: SECRET,
        DATABASE_URL: SECRET,
        HERCULES_TOKEN: SECRET,
        HERCULES_TASK_ID: 'must-not-reach-verifier',
      },
    });
    expect(env['PATH']).toBe('/bin');
    expect(env['XAI_API_KEY']).toBeUndefined();
    expect(env['DATABASE_URL']).toBeUndefined();
    expect(env['HERCULES_TOKEN']).toBeUndefined();
    expect(env['HERCULES_TASK_ID']).toBeUndefined();
  });
});

describe('reviewChildEnv', () => {
  it('allows only Grok/xAI model-auth plumbing, not other providers or secrets', () => {
    const { env } = reviewChildEnv({
      source: {
        PATH: '/bin',
        XAI_API_KEY: SECRET,
        OPENAI_API_KEY: SECRET,
        ANTHROPIC_API_KEY: SECRET,
        HTTPS_PROXY: 'http://user:pass@proxy:1',
        DATABASE_URL: SECRET,
        HERCULES_TASK_ID: 'must-not-reach-reviewer',
      },
    });
    expect(env['XAI_API_KEY']).toBe(SECRET);
    expect(env['OPENAI_API_KEY']).toBeUndefined();
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(env['HTTPS_PROXY']).toBeUndefined();
    expect(env['DATABASE_URL']).toBeUndefined();
    expect(env['HERCULES_TASK_ID']).toBeUndefined();
  });

  it('honors an explicit repo allowlist for the reviewer child too', () => {
    const { env } = reviewChildEnv({
      policy: effectiveRepoExecutionPolicy({ envAllowlist: ['PATH'] }),
      source: { PATH: '/bin', HOME: '/h', XAI_API_KEY: SECRET },
    });
    expect(env['PATH']).toBe('/bin');
    expect(env['HOME']).toBeUndefined();
    // Model-auth plumbing stays deliberate and separate from the allowlist.
    expect(env['XAI_API_KEY']).toBe(SECRET);
  });
});

describe('bootChildEnv', () => {
  it('compatible policy keeps toolchain prefixes but never secrets or loaders', () => {
    const { env } = bootChildEnv({
      source: {
        PATH: '/bin',
        NODE_ENV: 'test',
        NPM_CONFIG_CACHE: '/cache',
        NODE_OPTIONS: '--require /tmp/evil',
        XAI_API_KEY: SECRET,
        DATABASE_URL: SECRET,
        HERCULES_TOKEN: SECRET,
        HERCULES_WORK_DIR: '/prod',
      },
    });
    expect(env['PATH']).toBe('/bin');
    expect(env['NODE_ENV']).toBe('test');
    expect(env['NPM_CONFIG_CACHE']).toBe('/cache');
    expect(env['NODE_OPTIONS']).toBeUndefined();
    expect(env['XAI_API_KEY']).toBeUndefined();
    expect(env['DATABASE_URL']).toBeUndefined();
    expect(env['HERCULES_TOKEN']).toBeUndefined();
    expect(env['HERCULES_WORK_DIR']).toBeUndefined();
  });

  it('explicit allowlist is authoritative for L2 boot (no prefix widening)', () => {
    const { env } = bootChildEnv({
      policy: effectiveRepoExecutionPolicy({ envAllowlist: ['PATH'] }),
      source: { PATH: '/bin', HOME: '/h', NODE_ENV: 'test', NPM_CONFIG_CACHE: '/c' },
    });
    expect(env['PATH']).toBe('/bin');
    expect(env['HOME']).toBeUndefined();
    expect(env['NODE_ENV']).toBeUndefined();
    expect(env['NPM_CONFIG_CACHE']).toBeUndefined();
  });
});
