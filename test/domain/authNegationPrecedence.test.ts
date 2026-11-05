import { describe, it, expect } from 'vitest';
import {
  classifyFeature,
  hasAuthUiIntent,
} from '../../src/domain/featureType.js';
import { resolveEvidencePlan } from '../../src/domain/evidence.js';

const NL = String.fromCharCode(10);

describe('auth intent negation + settings false-friend precedence', () => {
  it.each([
    ['No login UI'],
    ['without authentication screen'],
    ['do not add a sign-in form'],
    ['never add a login page'],
    ['must not ship authentication UI'],
    ['Backend API only; no login chrome and no sign-in form'],
    ['\u4e0d\u8981\u767b\u5f55\u754c\u9762'],
    ['\u65e0\u9700\u8ba4\u8bc1\u5c4f\u5e55'],
    ['\u7981\u6b62\u6dfb\u52a0\u767b\u5f55\u8868\u5355'],
  ])('negative auth clause %j is not positive auth intent', (text) => {
    expect(hasAuthUiIntent(text)).toBe(false);
    expect(classifyFeature(text)).not.toBe('auth');
    const body =
      '## Goal' + NL + text + NL + NL + '## Definition of Done' + NL +
      '- [ ] (mechanical) unit tests';
    const plan = resolveEvidencePlan({ taskBody: body });
    expect(plan.steps.some((s) => s.selector?.includes('login'))).toBe(false);
    expect(plan.steps.some((s) => s.selector?.includes('auth'))).toBe(false);
  });

  it.each([
    ['No login UI. Add session expiry timeout re-auth flow.'],
    ['Do not add a sign-in form; ship credential input for API keys.'],
    ['without authentication screen on mobile; Login page for desktop admin'],
    ['\u4e0d\u8981\u767b\u5f55\u754c\u9762\uff1b\u4f1a\u8bdd\u8fc7\u671f\u91cd\u65b0\u8ba4\u8bc1'],
  ])('separate positive auth clause still wins: %j', (text) => {
    expect(hasAuthUiIntent(text)).toBe(true);
    expect(classifyFeature(text)).toBe('auth');
  });

  it('permission-management UI for repo deploy keys is auth despite deploy vocabulary', () => {
    const text = 'Permission-management UI for repo deploy keys';
    expect(hasAuthUiIntent(text)).toBe(true);
    expect(classifyFeature(text)).toBe('auth');
    const body =
      '## Goal' + NL + text + NL + NL + '## Definition of Done' + NL +
      '- [ ] (mechanical) unit tests';
    const plan = resolveEvidencePlan({ taskBody: body });
    expect(plan.steps.some((s) => s.selector?.includes('login'))).toBe(true);
  });

  it.each([
    ['Configure deploy settings for production', 'settings'],
    ['Move Logout button into Settings sheet', 'settings'],
    ['Rename sign-out label on the bottom nav', 'settings'],
    ['\u5e95\u680f\u767b\u51fa\u6539\u6210\u8bbe\u7f6e\u5165\u53e3', 'settings'],
    ['Add a submit form for task title validation', 'form'],
    ['Rotate stored credentials and redact secrets in logs', 'general'],
    ['Migrate password-hash algorithm; no UI changes', 'ui_generic'],
    ['When assigning work, keep the authoritative state', 'general'],
  ])('established non-auth classification retained: %j -> %s', (text, kind) => {
    expect(classifyFeature(text)).toBe(kind);
    expect(hasAuthUiIntent(text)).toBe(false);
  });
});
