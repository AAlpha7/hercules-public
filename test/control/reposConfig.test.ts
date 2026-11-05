import { describe, it, expect } from 'vitest';
import { parseReposConfig, serializeReposConfig, ReposConfigError, assertSafeRepoUrl, RepoUrlError, redactUrl } from '../../src/control/reposConfig.js';
import type { ReposConfig } from '../../src/domain/repos.js';

const YAML = `repos:
  my-app:
    url: git@github.com:me/my-app.git
    default_branch: main
    workflow: WORKFLOW.md
    max_concurrent: 1
  other-service:
    url: git@github.com:me/other-service.git
    default_branch: develop
`;

describe('parseReposConfig', () => {
  it('parses repos with explicit and defaulted fields', () => {
    const cfg = parseReposConfig(YAML);
    expect(Object.keys(cfg.repos).sort()).toEqual(['my-app', 'other-service']);

    const app = cfg.repos['my-app']!;
    expect(app.url).toBe('git@github.com:me/my-app.git');
    expect(app.defaultBranch).toBe('main');
    expect(app.workflow).toBe('WORKFLOW.md');
    expect(app.maxConcurrent).toBe(1);

    const other = cfg.repos['other-service']!;
    expect(other.defaultBranch).toBe('develop');
    // defaults (SPEC §6, §12)
    expect(other.workflow).toBe('WORKFLOW.md');
    expect(other.maxConcurrent).toBe(1);
  });

  it('exposes the repo key on each config', () => {
    const cfg = parseReposConfig(YAML);
    expect(cfg.repos['my-app']!.key).toBe('my-app');
  });

  it('rejects an unsafe repo key (SPEC §10)', () => {
    const bad = `repos:
  "../evil":
    url: x
    default_branch: main
`;
    expect(() => parseReposConfig(bad)).toThrow(ReposConfigError);
  });

  it('rejects max_concurrent below 1', () => {
    const bad = `repos:
  a:
    url: x
    default_branch: main
    max_concurrent: 0
`;
    expect(() => parseReposConfig(bad)).toThrow(ReposConfigError);
  });

  it('rejects missing required fields', () => {
    const bad = `repos:
  a:
    default_branch: main
`;
    expect(() => parseReposConfig(bad)).toThrow(ReposConfigError);
  });

  it('rejects malformed yaml', () => {
    expect(() => parseReposConfig(': : :\n  - [')).toThrow(ReposConfigError);
  });

  it('returns an empty registry for an empty repos map', () => {
    const cfg = parseReposConfig('repos: {}');
    expect(cfg.repos).toEqual({});
  });
});

describe('assertSafeRepoUrl', () => {
  it('accepts https URL', () => {
    expect(() => assertSafeRepoUrl('https://host/x.git')).not.toThrow();
  });

  it('accepts ssh URL', () => {
    expect(() => assertSafeRepoUrl('ssh://git@host/x.git')).not.toThrow();
  });

  it('accepts scp-like git remote (no scheme)', () => {
    expect(() => assertSafeRepoUrl('git@host:owner/x.git')).not.toThrow();
  });

  it('accepts absolute local path', () => {
    expect(() => assertSafeRepoUrl('/abs/local/path')).not.toThrow();
  });

  it('accepts file:// URL', () => {
    expect(() => assertSafeRepoUrl('file:///srv/x.git')).not.toThrow();
  });

  it('rejects empty string', () => {
    expect(() => assertSafeRepoUrl('')).toThrow(RepoUrlError);
  });

  it('rejects bare dash', () => {
    expect(() => assertSafeRepoUrl('-')).toThrow(RepoUrlError);
  });

  it('rejects --upload-pack=evil argument injection', () => {
    expect(() => assertSafeRepoUrl('--upload-pack=evil')).toThrow(RepoUrlError);
  });

  it('rejects ext:: transport helper (RCE)', () => {
    expect(() => assertSafeRepoUrl('ext::sh -c whoami')).toThrow(RepoUrlError);
  });

  it('rejects fd:: transport helper', () => {
    expect(() => assertSafeRepoUrl('fd::17')).toThrow(RepoUrlError);
  });

  it('rejects ftp:// (unsupported scheme)', () => {
    expect(() => assertSafeRepoUrl('ftp://host/x')).toThrow(RepoUrlError);
  });
});

describe('redactUrl', () => {
  it('redacts user:password credentials from an https URL', () => {
    expect(redactUrl('https://user:secret@host/x.git')).toBe('https://***@host/x.git');
  });

  it('leaves a plain URL without credentials unchanged', () => {
    expect(redactUrl('https://host/x.git')).toBe('https://host/x.git');
  });

  it('leaves an scp-like git remote (no //) unchanged', () => {
    expect(redactUrl('git@host:path')).toBe('git@host:path');
  });
});

describe('serializeReposConfig', () => {
  const config: ReposConfig = {
    repos: {
      web: { key: 'web', url: 'git@host:web.git', defaultBranch: 'main', workflow: 'WORKFLOW.md', maxConcurrent: 2, adapter: null, readiness: 'ready' },
      api: { key: 'api', url: '/srv/api', defaultBranch: 'trunk', workflow: 'docs/FLOW.md', maxConcurrent: 1, adapter: null, readiness: 'ready' },
    },
  };

  it('round-trips through parseReposConfig', () => {
    expect(parseReposConfig(serializeReposConfig(config))).toEqual(config);
  });

  it('emits snake_case keys sorted by repo key', () => {
    const text = serializeReposConfig(config);
    expect(text.indexOf('api:')).toBeLessThan(text.indexOf('web:'));
    expect(text).toContain('default_branch:');
    expect(text).toContain('max_concurrent:');
    expect(text).not.toContain('defaultBranch');
  });

  it('round-trips an optional adapter override and omits null on serialize', () => {
    const withAdapter: ReposConfig = {
      repos: {
        bookshelf: {
          key: 'bookshelf',
          url: 'https://github.com/me/sample-app.git',
          defaultBranch: 'main',
          workflow: 'WORKFLOW.md',
          maxConcurrent: 1,
          adapter: 'grok', readiness: 'ready',
        },
      },
    };
    const text = serializeReposConfig(withAdapter);
    expect(text).toContain('adapter: grok');
    expect(parseReposConfig(text)).toEqual(withAdapter);

    const textNoOverride = serializeReposConfig(config);
    expect(textNoOverride).not.toMatch(/^\s*adapter:/m);
  });

  it('parses optional cargo_target_dir and round-trips', () => {
    const yaml = `repos:
  rust-app:
    url: git@host:rust-app.git
    default_branch: main
    cargo_target_dir: /home/u/proj/.shared-target
`;
    const cfg = parseReposConfig(yaml);
    expect(cfg.repos['rust-app']!.cargoTargetDir).toBe('/home/u/proj/.shared-target');
    const text = serializeReposConfig(cfg);
    expect(text).toContain('cargo_target_dir:');
    expect(parseReposConfig(text)).toEqual(cfg);
  });

  it('omits cargo_target_dir when null', () => {
    const text = serializeReposConfig(config);
    expect(text).not.toContain('cargo_target_dir');
  });

  it('rejects an unknown adapter kind', () => {
    const bad = `repos:
  a:
    url: x
    default_branch: main
    adapter: gpt-5
`;
    expect(() => parseReposConfig(bad)).toThrow(ReposConfigError);
  });

  it('parses and round-trips execution_policy (guardian profile)', () => {
    const yaml = `repos:
  guarded:
    url: git@host:g.git
    default_branch: main
    execution_policy:
      profile: guardian
      env_allowlist:
        - PATH
        - HOME
`;
    const cfg = parseReposConfig(yaml);
    const ep = cfg.repos['guarded']!.executionPolicy;
    expect(ep).toEqual({
      profile: 'guardian',
      envAllowlist: ['PATH', 'HOME'],
    });
    const text = serializeReposConfig(cfg);
    expect(text).toContain('execution_policy:');
    expect(text).toContain('profile: guardian');
    expect(parseReposConfig(text)).toEqual(cfg);
  });

  it('rejects unknown execution_policy fields that fail validation', () => {
    const bad = `repos:
  a:
    url: x
    default_branch: main
    execution_policy:
      sandbox: hypervisor
`;
    expect(() => parseReposConfig(bad)).toThrow(ReposConfigError);
  });

  it('omits execution_policy when absent (compatible default path)', () => {
    const text = serializeReposConfig(config);
    expect(text).not.toContain('execution_policy');
  });

  it('parses auto_merge with defaults when only enabled is set', () => {
    const yaml = `repos:
  pilot:
    url: git@host:p.git
    default_branch: main
    auto_merge:
      enabled: true
`;
    const cfg = parseReposConfig(yaml);
    expect(cfg.repos['pilot']!.autoMerge).toEqual({
      enabled: true,
      dwellMinutes: 30,
      maxSize: 'M',
    });
  });

  it('parses auto_merge with explicit dwell_minutes and max_size', () => {
    const yaml = `repos:
  pilot:
    url: git@host:p.git
    default_branch: main
    auto_merge:
      enabled: true
      dwell_minutes: 15
      max_size: S
`;
    const cfg = parseReposConfig(yaml);
    expect(cfg.repos['pilot']!.autoMerge).toEqual({
      enabled: true,
      dwellMinutes: 15,
      maxSize: 'S',
    });
    const text = serializeReposConfig(cfg);
    expect(text).toContain('auto_merge:');
    expect(text).toContain('dwell_minutes: 15');
    expect(text).toContain('max_size: S');
    expect(parseReposConfig(text)).toEqual(cfg);
  });

  it('rejects auto_merge max_size XL and dwell_minutes -1', () => {
    expect(() =>
      parseReposConfig(`repos:
  a:
    url: x
    default_branch: main
    auto_merge:
      enabled: true
      max_size: XL
`),
    ).toThrow(ReposConfigError);
    expect(() =>
      parseReposConfig(`repos:
  a:
    url: x
    default_branch: main
    auto_merge:
      enabled: true
      dwell_minutes: -1
`),
    ).toThrow(ReposConfigError);
  });

  it('omits auto_merge when absent', () => {
    const text = serializeReposConfig(config);
    expect(text).not.toContain('auto_merge');
  });

  it('round-trips explicitly registered owner checkouts and rejects unsafe registrations', () => {
    const parsed = parseReposConfig(`repos:
  demo:
    url: git@example:demo.git
    default_branch: main
    owner_checkouts:
      - id: owner-main
        path: /srv/source-owner/demo
`);
    expect(parsed.repos['demo']?.ownerCheckouts).toEqual([
      { id: 'owner-main', path: '/srv/source-owner/demo' },
    ]);
    expect(parseReposConfig(serializeReposConfig(parsed))).toEqual(parsed);
    expect(() => parseReposConfig(`repos:
  demo:
    url: x
    default_branch: main
    owner_checkouts:
      - id: ../escape
        path: relative/path
`)).toThrow(ReposConfigError);
  });
});
