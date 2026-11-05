/**
 * Deterministic host_operation / deploy children get a strict fixed-name env
 * allowlist — never BOOT_ENV_ALLOW_PREFIXES (NODE_*, NPM_*, …), never credentials.
 */
import { describe, it, expect } from 'vitest';
import { bootAppEnv, hostChildEnv } from '../../src/adapters/env.js';

const SAFE_BASE: NodeJS.ProcessEnv = {
  PATH: '/usr/bin:/bin',
  HOME: '/home/ubuntu',
  USER: 'ubuntu',
  LOGNAME: 'ubuntu',
  SHELL: '/bin/bash',
  LANG: 'en_US.UTF-8',
  LANGUAGE: 'en_US',
  LC_ALL: 'C.UTF-8',
  TZ: 'UTC',
  TERM: 'xterm-256color',
  TMPDIR: '/tmp',
  JAVA_HOME: '/usr/lib/jvm/default',
  CARGO_HOME: '/home/ubuntu/.cargo',
};

const HOSTILE: NodeJS.ProcessEnv = {
  NODE_OPTIONS: '--require /tmp/evil.js',
  NPM_TOKEN: 'npm-secret',
  NODE_AUTH_TOKEN: 'node-auth-secret',
  npm_config__auth: 'npm-auth-secret',
  'npm_config_//registry.npmjs.org/:_authToken': 'registry-token',
  NPM_CONFIG__AUTH: 'upper-auth',
  DATABASE_URL: 'postgres://user:pass@prod/db',
  XAI_API_KEY: 'xai-secret',
  GITHUB_TOKEN: 'ghp_secret',
  BASH_ENV: '/tmp/evil.bashrc',
  ENV: '/tmp/evil.profile',
  LD_PRELOAD: '/tmp/evil.so',
  LD_LIBRARY_PATH: '/tmp/evil-lib',
  DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib',
  DYLD_LIBRARY_PATH: '/tmp/evil-dyld',
  HTTPS_PROXY: 'http://user:pass@proxy.example:8080',
  HTTP_PROXY: 'http://user:pass@proxy.example:8080',
  https_proxy: 'http://user:pass@proxy.example:8080',
  OPENAI_API_KEY: 'sk-secret',
  MY_APP_PASSWORD: 'pw',
  SOME_SECRET: 's',
  AWS_SECRET_ACCESS_KEY: 'aws',
  HERCULES_TOKEN: 'daemon-token',
  HERCULES_WORK_DIR: '/prod/work',
};

describe('hostChildEnv (host_operation / deploy child env)', () => {
  it('keeps required safe fixed names', () => {
    const out = hostChildEnv({ ...SAFE_BASE, ...HOSTILE });
    expect(out['PATH']).toBe(SAFE_BASE['PATH']);
    expect(out['HOME']).toBe(SAFE_BASE['HOME']);
    expect(out['USER']).toBe(SAFE_BASE['USER']);
    expect(out['LOGNAME']).toBe(SAFE_BASE['LOGNAME']);
    expect(out['SHELL']).toBe(SAFE_BASE['SHELL']);
    expect(out['LANG']).toBe(SAFE_BASE['LANG']);
    expect(out['LANGUAGE']).toBe(SAFE_BASE['LANGUAGE']);
    expect(out['LC_ALL']).toBe(SAFE_BASE['LC_ALL']);
    expect(out['TZ']).toBe(SAFE_BASE['TZ']);
    expect(out['TERM']).toBe(SAFE_BASE['TERM']);
    expect(out['TMPDIR']).toBe(SAFE_BASE['TMPDIR']);
    expect(out['JAVA_HOME']).toBe(SAFE_BASE['JAVA_HOME']);
    expect(out['CARGO_HOME']).toBe(SAFE_BASE['CARGO_HOME']);
  });

  it('drops all listed injection / credential / loader / proxy vars', () => {
    const out = hostChildEnv({ ...SAFE_BASE, ...HOSTILE });
    for (const k of Object.keys(HOSTILE)) {
      expect(out[k], `${k} must be absent from host child env`).toBeUndefined();
    }
  });

  it('does not reuse bootAppEnv broad prefixes (NODE_*, NPM_*, pnpm pass boot, not host)', () => {
    const shared: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      NODE_OPTIONS: '--max-old-space-size=512',
      NPM_CONFIG_CACHE: '/tmp/npm-cache',
      PNPM_HOME: '/home/ubuntu/.pnpm',
      NVM_DIR: '/home/ubuntu/.nvm',
      COREPACK_ROOT: '/x',
      LC_TIME: 'en_US.UTF-8',
    };
    const boot = bootAppEnv(shared);
    const host = hostChildEnv(shared);
    // bootAppEnv intentionally allows toolchain prefixes:
    expect(boot['NODE_OPTIONS']).toBe('--max-old-space-size=512');
    expect(boot['PNPM_HOME']).toBe('/home/ubuntu/.pnpm');
    expect(boot['LC_TIME']).toBe('en_US.UTF-8');
    // hostChildEnv must not:
    expect(host['NODE_OPTIONS']).toBeUndefined();
    expect(host['NPM_CONFIG_CACHE']).toBeUndefined();
    expect(host['PNPM_HOME']).toBeUndefined();
    expect(host['NVM_DIR']).toBeUndefined();
    expect(host['COREPACK_ROOT']).toBeUndefined();
    expect(host['LC_TIME']).toBeUndefined(); // only fixed locale names, not LC_* prefix
    expect(host['PATH']).toBe('/usr/bin');
  });

  it('is an allowlist: unknown business vars are dropped', () => {
    const out = hostChildEnv({ PATH: '/usr/bin', RANDOM_BUSINESS_VAR: 'x', CI: '1' });
    expect(out['PATH']).toBe('/usr/bin');
    expect(out['RANDOM_BUSINESS_VAR']).toBeUndefined();
    expect(out['CI']).toBeUndefined();
  });
});
