import { describe, it, expect } from 'vitest';
import { parseReposConfig, ReposConfigError } from '../../src/control/reposConfig.js';

const nl = String.fromCharCode(10);
const yaml = (lines: string[]): string => lines.join(nl) + nl;

describe('execution_policy YAML validation', () => {
  it('rejects unknown keys (typos) via strict schema', () => {
    const bad = yaml([
      'repos:',
      '  a:',
      '    url: x',
      '    default_branch: main',
      '    execution_policy:',
      '      profil: guardian',
    ]);
    expect(() => parseReposConfig(bad)).toThrow(ReposConfigError);
  });

  it('rejects guardian with forbid flags relaxed', () => {
    const bad = yaml([
      'repos:',
      '  a:',
      '    url: x',
      '    default_branch: main',
      '    execution_policy:',
      '      profile: guardian',
      '      forbid_production_secrets: false',
    ]);
    expect(() => parseReposConfig(bad)).toThrow(ReposConfigError);
    expect(() => parseReposConfig(bad)).toThrow(/forbid/);
  });

  it('rejects guardian with a relaxed sandbox/network/workspace_write posture', () => {
    for (const line of ['sandbox: off', 'network: unrestricted', 'workspace_write: false']) {
      const bad = yaml([
        'repos:',
        '  a:',
        '    url: x',
        '    default_branch: main',
        '    execution_policy:',
        '      profile: guardian',
        '      ' + line,
      ]);
      expect(() => parseReposConfig(bad)).toThrow(ReposConfigError);
    }
  });

  it('rejects workspace_write without a workspace sandbox (read-only is contradictory)', () => {
    for (const sandbox of ['read-only', 'off', 'none']) {
      const bad = yaml([
        'repos:',
        '  a:',
        '    url: x',
        '    default_branch: main',
        '    execution_policy:',
        '      sandbox: ' + sandbox,
        '      workspace_write: true',
      ]);
      expect(() => parseReposConfig(bad)).toThrow(ReposConfigError);
    }
    // Omitted sandbox defaults to none — still contradictory with workspace_write.
    const implicit = yaml([
      'repos:',
      '  a:',
      '    url: x',
      '    default_branch: main',
      '    execution_policy:',
      '      workspace_write: true',
    ]);
    expect(() => parseReposConfig(implicit)).toThrow(ReposConfigError);
  });

  it('rejects unknown sandbox / network / profile values', () => {
    for (const line of ['sandbox: hypervisor', 'network: airgapped', 'profile: paranoid']) {
      const bad = yaml([
        'repos:',
        '  a:',
        '    url: x',
        '    default_branch: main',
        '    execution_policy:',
        '      ' + line,
      ]);
      expect(() => parseReposConfig(bad)).toThrow(ReposConfigError);
    }
  });

  it('rejects an invalid env_allowlist entry', () => {
    const bad = yaml([
      'repos:',
      '  a:',
      '    url: x',
      '    default_branch: main',
      '    execution_policy:',
      '      env_allowlist:',
      '        - bad-name',
    ]);
    expect(() => parseReposConfig(bad)).toThrow(ReposConfigError);
  });

  it('accepts and round-trips a full explicit policy', () => {
    const good = yaml([
      'repos:',
      '  a:',
      '    url: x',
      '    default_branch: main',
      '    execution_policy:',
      '      profile: guardian',
      '      sandbox: workspace',
      '      network: "off"',
      '      env_allowlist:',
      '        - PATH',
      '        - HOME',
      '      workspace_write: true',
    ]);
    const cfg = parseReposConfig(good);
    expect(cfg.repos['a']!.executionPolicy).toEqual({
      profile: 'guardian',
      sandbox: 'workspace',
      network: 'off',
      envAllowlist: ['PATH', 'HOME'],
      workspaceWrite: true,
    });
  });
});
