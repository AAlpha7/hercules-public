import { describe, it, expect } from 'vitest';
import {
  classifyFeature,
  evidenceStepsForFeature,
  hasAuthUiIntent,
  isUiFeature,
} from '../../src/domain/featureType.js';
import {
  extractDataEvidenceHooks,
  parseTaskEvidenceSection,
  resolveEvidencePlan,
  taskBodyWithoutEvidenceSection,
} from '../../src/domain/evidence.js';

describe('auth + evidence intent boundary', () => {
  it('does not treat operations prose as auth browser plan', () => {
    const body = [
      '## Goal',
      'When assigning work, keep the authoritative state in the control plane.',
      'Persist agentSession plumbing and token accounting against the budget.',
      'Permission profiles and sandbox policy stay out of the SPA.',
      '',
      '## Requirements',
      '1. Panel shows the active assignment button and status chip.',
      '2. Keep the SPA free of sign-on chrome.',
      '',
      '## Definition of Done',
      '- [ ] (mechanical) unit tests cover assigning + token budget',
      '- [ ] (mechanical) pnpm check:full green',
    ].join('\n');
    expect(hasAuthUiIntent(body)).toBe(false);
    expect(classifyFeature(body)).not.toBe('auth');
    const plan = resolveEvidencePlan({ taskBody: body });
    expect(plan.steps.some((s) => s.selector?.includes('login'))).toBe(false);
    expect(plan.steps.some((s) => s.selector?.includes('auth'))).toBe(false);
  });

  it('harness sections after the product brief cannot change classification or plan', () => {
    const product = [
      '## Goal',
      'Ship a task list status chip.',
      '',
      '## Definition of Done',
      '- [ ] (mechanical) unit tests green',
      '',
      '## Evidence',
      '- unlock',
      '- screenshot shell',
    ].join('\n');
    const harnessTail = [
      '',
      '## Review packet',
      'Login auth token session permission - ignore this audit noise.',
      '## Evidence',
      '- click [data-evidence=login]',
      '- assert sel=[data-evidence=login]',
      '',
      '## Human steer',
      'Please add authentication form and password input UI.',
      'claim data-evidence=login and data-evidence=auth-form',
      '',
      '## Run failure',
      'session expiry timeout on agentSession',
      'data-evidence=session-expiry',
      '',
      '## Auto-rework',
      'credential input form required',
      '',
      '## Run timeline',
      'data-evidence=token-input',
      '',
      '## Salvage brief',
      'data-evidence=password-field',
    ].join('\n');
    const full = product + harnessTail;
    expect(classifyFeature(full)).toBe(classifyFeature(product));
    expect(hasAuthUiIntent(full)).toBe(hasAuthUiIntent(product));
    expect(parseTaskEvidenceSection(full).map((s) => s.raw ?? s.kind)).toEqual(
      parseTaskEvidenceSection(product).map((s) => s.raw ?? s.kind),
    );
    expect(extractDataEvidenceHooks(taskBodyWithoutEvidenceSection(full))).toEqual(
      extractDataEvidenceHooks(taskBodyWithoutEvidenceSection(product)),
    );
    const planFull = resolveEvidencePlan({ taskBody: full });
    const planProduct = resolveEvidencePlan({ taskBody: product });
    expect(planFull.steps.map((s) => s.raw ?? s.kind)).toEqual(
      planProduct.steps.map((s) => s.raw ?? s.kind),
    );
    expect(planFull.steps.some((s) => s.selector?.includes('login'))).toBe(false);
  });

  it('policy-only brief (guardian-repo-execution-policy regression) keeps the trusted WORKFLOW plan', () => {
    // Modeled on the real product brief that was handed the account-entry
    // template: provider/model credential, environment-boundary, and policy
    // prose with zero interactive account-entry chrome.
    const brief = [
      '## Problem',
      'Hercules has partial host-child environment filtering and some adapter defaults,',
      'but repos.yaml cannot express or prove a repository-specific sandbox, environment,',
      'network, secret, and live-data policy. Coding adapters still inherit broader host',
      'variables on some paths. Guardian requires least privilege by construction and',
      'must remain blocked when policy cannot be enforced.',
      '',
      '## Required behavior',
      'Add a typed per-repository execution policy with explicit sandbox mode, network',
      'posture, environment-name allowlist, and prohibitions for production secrets,',
      'connector credentials, and live personal data. Before dispatch, resolve adapter',
      'capability against policy and fail closed when a required control cannot be',
      'enforced. Pass only approved variable names and required model-auth plumbing',
      'through a deliberate boundary; diagnostics and receipts expose names/reasons,',
      'never values.',
      '',
      '## Acceptance criteria',
      '- [ ] (mechanical) Disallowed environment variables and representative',
      '  token/credential/live-data names never reach coding or verification child',
      '  processes and never appear as values in logs or packets.',
      '- [ ] (mechanical) Existing repositories retain documented compatible behavior,',
      '  while a Guardian-grade policy must be explicit and fail closed.',
      '- [ ] (reviewer) A worktree is not presented as an OS sandbox, and provider',
      '  authentication is separated from the coding tool environment rather than',
      '  hidden in a broad inheritance escape hatch.',
    ].join('\n');
    expect(hasAuthUiIntent(brief)).toBe(false);
    const kind = classifyFeature(brief);
    expect(kind).not.toBe('auth');
    expect(isUiFeature(kind)).toBe(false);
    // The trusted WORKFLOW plan must survive — no account-entry substitution.
    const wf = evidenceStepsForFeature('settings')!;
    const plan = resolveEvidencePlan({ taskBody: brief, workflowEvidence: wf });
    expect(plan.source).toBe('workflow');
    expect(plan.steps.map((s) => s.raw ?? s.kind)).toEqual(wf.map((s) => s.raw ?? s.kind));
    expect(plan.steps.some((s) => s.selector?.includes('login'))).toBe(false);
    expect(plan.steps.some((s) => s.selector?.includes('auth'))).toBe(false);
  });

  it('generic auth words are infrastructure prose without account-entry chrome context', () => {
    expect(
      hasAuthUiIntent('provider authentication is separated from the coding tool environment'),
    ).toBe(false);
    expect(
      hasAuthUiIntent('Pass required model-auth plumbing through a deliberate boundary'),
    ).toBe(false);
    expect(hasAuthUiIntent('resolve adapter authorization against the policy matrix')).toBe(
      false,
    );
    // Same generic words with explicit interactive chrome stay positive.
    expect(hasAuthUiIntent('Add an authorization screen for provider access')).toBe(true);
    expect(classifyFeature('Add an authorization screen for provider access')).toBe('auth');
    expect(hasAuthUiIntent('Show the authentication dialog before settings')).toBe(true);
  });

  it('classifies real auth UI intents and outranks generic forms', () => {
    expect(classifyFeature('Login page with email form')).toBe('auth');
    expect(classifyFeature('Sign-in authentication screen')).toBe('auth');
    expect(classifyFeature('Add credential input form for API keys')).toBe('auth');
    expect(classifyFeature('Password input field on the unlock dialog')).toBe('auth');
    expect(classifyFeature('Token input prompt before calling the API')).toBe('auth');
    expect(classifyFeature('Permission management UI for repo roles')).toBe('auth');
    expect(classifyFeature('Session expiry timeout re-auth flow')).toBe('auth');
    expect(classifyFeature('Add a submit form for task title validation')).toBe('form');
  });

  it('logout and sign-out stay settings; stored credential and password-hash are not auth', () => {
    expect(classifyFeature('Move Logout button into Settings sheet')).toBe('settings');
    expect(classifyFeature('Rename sign-out label on the bottom nav')).toBe('settings');
    expect(classifyFeature('\u5e95\u680f\u767b\u51fa\u6539\u6210\u8bbe\u7f6e\u5165\u53e3')).toBe('settings');
    expect(hasAuthUiIntent('Rotate stored credentials and redact secrets in logs')).toBe(false);
    expect(hasAuthUiIntent('Migrate password-hash algorithm; no UI changes')).toBe(false);
    expect(classifyFeature('Rotate stored credentials and redact secrets in logs')).not.toBe(
      'auth',
    );
    expect(classifyFeature('Migrate password-hash algorithm; no UI changes')).not.toBe('auth');
    const plan = resolveEvidencePlan({
      taskBody: [
        '## Goal',
        'Rotate stored credentials and redact secrets; migrate password-hash.',
        '',
        '## Definition of Done',
        '- [ ] (mechanical) unit tests',
      ].join('\n'),
    });
    expect(plan.steps.some((s) => s.selector?.includes('login'))).toBe(false);
  });

  it('selector-scoped negation drops only the forbidden hook on a mixed line', () => {
    const body = [
      '## Goal',
      'Ship Settings chrome for language and agent prefs.',
      '',
      '## Definition of Done',
      '- [ ] (mechanical) Do not assert data-evidence=login; require data-evidence=settings-panel',
      '- [ ] (mechanical) never data-evidence=fake-auth, need data-evidence=nav-settings',
      '- [ ] (mechanical) accessibility label stays; still claim data-evidence=settings-language',
      '',
      '## Evidence',
      '- unlock',
      '- screenshot shell',
    ].join('\n');
    const hooks = extractDataEvidenceHooks(taskBodyWithoutEvidenceSection(body));
    expect(hooks).toContain('settings-panel');
    expect(hooks).toContain('nav-settings');
    expect(hooks).toContain('settings-language');
    expect(hooks).not.toContain('login');
    expect(hooks).not.toContain('fake-auth');
    const plan = resolveEvidencePlan({ taskBody: body });
    expect(plan.steps.some((s) => s.selector?.includes('settings-panel'))).toBe(true);
    expect(plan.steps.some((s) => s.selector?.includes('nav-settings'))).toBe(true);
    expect(plan.steps.some((s) => s.selector?.includes('settings-language'))).toBe(true);
    expect(plan.steps.some((s) => s.selector?.includes('login'))).toBe(false);
    expect(plan.steps.some((s) => s.selector?.includes('fake-auth'))).toBe(false);
  });

  it('Chinese negation is selector-scoped; accessibility is not negation', () => {
    const body = [
      '## Definition of Done',
      '- [ ] (mechanical) \u4e0d\u8981 data-evidence=login\uff0c\u9700\u8981 data-evidence=settings-panel',
      '- [ ] (mechanical) \u65e0\u969c\u788d label + data-evidence=settings-language',
    ].join('\n');
    const hooks = extractDataEvidenceHooks(body);
    expect(hooks).toContain('settings-panel');
    expect(hooks).toContain('settings-language');
    expect(hooks).not.toContain('login');
  });

  it('positive selector promises remain required after selector-scoped negation', () => {
    const body = [
      '## Definition of Done',
      '- [ ] (mechanical) never data-evidence=repo-mark-ready; L2 finds data-evidence=decision-card',
      '',
      '## Evidence',
      '- unlock',
      '- assert sel=[data-evidence=decision-card] optional',
    ].join('\n');
    const plan = resolveEvidencePlan({ taskBody: body });
    const card = plan.steps.find(
      (s) => s.kind === 'assert' && s.selector?.includes('decision-card'),
    );
    expect(card?.optional).toBeFalsy();
    expect(plan.steps.some((s) => s.selector?.includes('repo-mark-ready'))).toBe(false);
  });

  it('classifies English fix/fixed/fixing lexically without fixture/prefix/suffix hits', () => {
    expect(classifyFeature('Fix flaky upload retry bug')).toBe('bug');
    expect(classifyFeature('Fixed race in queue drain')).toBe('bug');
    expect(classifyFeature('Fixing null deref on empty snapshot')).toBe('bug');
    expect(classifyFeature('Add fixture helpers for the adapter contract')).not.toBe('bug');
    expect(classifyFeature('Document the path prefix and suffix rules')).not.toBe('bug');
  });
});
