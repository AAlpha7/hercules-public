/**
 * SPEC §10: the L2 app-under-test boots with dummy creds and MUST NOT reach
 * production. scrubHerculesEnv (agent path) only strips HERCULES_*, so host
 * secrets (model keys, cloud creds, DB URLs) would flow to the booted product
 * app. bootAppEnv is an allowlist: infra/runtime vars pass; everything else —
 * including anything secret-shaped — is dropped. WORKFLOW boot sets what it
 * needs inline in the command string, so the inherited env only needs the
 * machinery to run node/pnpm.
 */
import { describe, it, expect } from 'vitest';
import { bootAppEnv, hostCommandEnv } from '../../src/adapters/env.js';

describe('bootAppEnv (L2 boot secret scoping)', () => {
  it('passes infra/runtime vars needed to run node/pnpm', () => {
    const out = bootAppEnv({
      PATH: '/usr/bin',
      HOME: '/home/ubuntu',
      LANG: 'en_US.UTF-8',
      NODE_OPTIONS: '--max-old-space-size=512',
      PNPM_HOME: '/home/ubuntu/.pnpm',
      COREPACK_ROOT: '/x',
      NVM_DIR: '/home/ubuntu/.nvm',
      TZ: 'UTC',
    });
    expect(out['PATH']).toBe('/usr/bin');
    expect(out['HOME']).toBe('/home/ubuntu');
    expect(out['LANG']).toBe('en_US.UTF-8');
    expect(out['NODE_OPTIONS']).toBe('--max-old-space-size=512');
    expect(out['PNPM_HOME']).toBe('/home/ubuntu/.pnpm');
    expect(out['COREPACK_ROOT']).toBe('/x');
    expect(out['NVM_DIR']).toBe('/home/ubuntu/.nvm');
    expect(out['TZ']).toBe('UTC');
  });

  it('drops secret-shaped and cloud/DB vars (the fail-open leak)', () => {
    const out = bootAppEnv({
      PATH: '/usr/bin',
      OPENAI_API_KEY: 'sk-secret',
      XAI_API_KEY: 'xai-secret',
      ANTHROPIC_API_KEY: 'ant-secret',
      GITHUB_TOKEN: 'ghp_secret',
      STAGING_UI_TOKEN: 'tok',
      DATABASE_URL: 'postgres://prod/db',
      AWS_SECRET_ACCESS_KEY: 'aws',
      CF_API_TOKEN: 'cf',
      MY_APP_PASSWORD: 'pw',
      SOME_CREDENTIAL: 'c',
    });
    expect(out['PATH']).toBe('/usr/bin');
    for (const k of [
      'OPENAI_API_KEY', 'XAI_API_KEY', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN',
      'STAGING_UI_TOKEN', 'DATABASE_URL', 'AWS_SECRET_ACCESS_KEY', 'CF_API_TOKEN',
      'MY_APP_PASSWORD', 'SOME_CREDENTIAL',
    ]) {
      expect(out[k], `${k} must be dropped`).toBeUndefined();
    }
  });

  it('always drops HERCULES_* (never re-widens the work-dir/token incident)', () => {
    const out = bootAppEnv({ PATH: '/usr/bin', HERCULES_WORK_DIR: '/prod', HERCULES_TOKEN: 't' });
    expect(out['HERCULES_WORK_DIR']).toBeUndefined();
    expect(out['HERCULES_TOKEN']).toBeUndefined();
  });

  it('drops an unknown non-infra var by default (allowlist, not denylist)', () => {
    const out = bootAppEnv({ PATH: '/usr/bin', RANDOM_BUSINESS_VAR: 'x' });
    expect(out['RANDOM_BUSINESS_VAR']).toBeUndefined();
  });
});

describe('hostCommandEnv (alias of hostChildEnv — strict fixed names)', () => {
  it('proves credentials and injection vars are absent while safe fixed names remain', () => {
    const out = hostCommandEnv({
      PATH: '/usr/bin',
      HOME: '/home/u',
      LANG: 'C.UTF-8',
      XAI_API_KEY: 'xai-secret-value',
      OPENAI_API_KEY: 'sk-secret',
      DATABASE_URL: 'postgres://prod/db',
      GITHUB_TOKEN: 'ghp_secret',
      ANTHROPIC_API_KEY: 'ant-secret',
      AWS_SECRET_ACCESS_KEY: 'aws',
      HERCULES_TOKEN: 'daemon-token',
      NPM_TOKEN: 'npm-secret-token',
      NODE_AUTH_TOKEN: 'node-auth-secret',
      NODE_OPTIONS: '--require /tmp/evil.js',
      BASH_ENV: '/tmp/evil',
      LD_PRELOAD: '/tmp/evil.so',
      HTTPS_PROXY: 'http://user:pass@proxy:8080',
      RANDOM_BUSINESS_VAR: 'nope',
    });
    expect(out['PATH']).toBe('/usr/bin');
    expect(out['HOME']).toBe('/home/u');
    expect(out['LANG']).toBe('C.UTF-8');
    for (const k of [
      'XAI_API_KEY',
      'OPENAI_API_KEY',
      'DATABASE_URL',
      'GITHUB_TOKEN',
      'ANTHROPIC_API_KEY',
      'AWS_SECRET_ACCESS_KEY',
      'HERCULES_TOKEN',
      'NPM_TOKEN',
      'NODE_AUTH_TOKEN',
      'NODE_OPTIONS',
      'BASH_ENV',
      'LD_PRELOAD',
      'HTTPS_PROXY',
      'RANDOM_BUSINESS_VAR',
    ]) {
      expect(out[k], `${k} must be absent from host command env`).toBeUndefined();
    }
  });
});
