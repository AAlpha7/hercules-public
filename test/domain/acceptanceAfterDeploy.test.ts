import { describe, it, expect } from 'vitest';
import {
  parseDefinitionOfDone,
  listHumanCriteriaTexts,
  listAfterDeployCriteriaTexts,
  missingHumanAcknowledgements,
} from '../../src/domain/acceptance.js';

describe('(human, after deploy) modifier', () => {
  const forms: readonly { tag: string; text: string }[] = [
    { tag: '(human, after deploy)', text: 'Check badge on production' },
    { tag: '(human: after-deploy)', text: 'Confirm CDN cache' },
    { tag: '(human, post-deploy)', text: 'Smoke the live URL' },
    { tag: '(人工, 上线后)', text: '生产环境点开设置' },
    { tag: '(人工，部署后)', text: '确认线上入口' },
  ];

  it.each(forms)('parses $tag → kind human + afterDeploy', ({ tag, text }) => {
    const dod = parseDefinitionOfDone(`
## Definition of Done
- [ ] ${tag} ${text}
`);
    expect(dod.criteria).toHaveLength(1);
    const c = dod.criteria[0]!;
    expect(c.kind).toBe('human');
    expect(c.afterDeploy).toBe(true);
    expect(c.text).toBe(text);
    expect(Object.prototype.hasOwnProperty.call(c, 'afterDeploy')).toBe(true);
  });

  it('plain (human) has no afterDeploy key', () => {
    const dod = parseDefinitionOfDone(`
## Definition of Done
- [ ] (human) Phone check only
`);
    const c = dod.criteria[0]!;
    expect(c.kind).toBe('human');
    expect(c.text).toBe('Phone check only');
    expect(c.afterDeploy).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(c, 'afterDeploy')).toBe(false);
  });

  it('listHumanCriteriaTexts excludes after-deploy; keeps plain human + checkpoint', () => {
    const body = `
## Definition of Done
- [ ] (mechanical) gates @gate:test
- [ ] (human) Device UX ok
- [ ] (human, after deploy) Confirm live badge
- [ ] (checkpoint) before merge: look at staging
`;
    expect(listHumanCriteriaTexts(body)).toEqual([
      'Device UX ok',
      'before merge: look at staging',
    ]);
    expect(listAfterDeployCriteriaTexts(body)).toEqual(['Confirm live badge']);
  });

  it('listAfterDeployCriteriaTexts returns texts in order', () => {
    const body = `
## Acceptance criteria
- [ ] (human, after deploy) First live check
- [ ] (human) Blocking phone check
- [ ] (人工, 上线后) Second live check
`;
    expect(listAfterDeployCriteriaTexts(body)).toEqual([
      'First live check',
      'Second live check',
    ]);
  });

  it('missingHumanAcknowledgements is empty when only human line is after-deploy', () => {
    const body = `
## Definition of Done
- [ ] (mechanical) tests pass @gate:test
- [ ] (human, after deploy) Check production dashboard
`;
    expect(listHumanCriteriaTexts(body)).toEqual([]);
    expect(missingHumanAcknowledgements(body, [])).toEqual([]);
    expect(listAfterDeployCriteriaTexts(body)).toEqual(['Check production dashboard']);
  });

  it('packet fallback skips `(human, after deploy)` lines', () => {
    const body = `
## Task
Hollow body with no DoD section

## Review packet
- ⏳ \`(human)\` looks good on phone
- ⏳ \`(human, after deploy)\` confirm live URL
`;
    expect(listHumanCriteriaTexts(body)).toEqual(['looks good on phone']);
    expect(listAfterDeployCriteriaTexts(body)).toEqual([]);
  });

  it('needsHuman stays true when only after-deploy human lines exist', () => {
    const dod = parseDefinitionOfDone(`
## Definition of Done
- [ ] (mechanical) gates @gate:test
- [ ] (human, after deploy) live check
`);
    expect(dod.needsHuman).toBe(true);
    expect(dod.criteria.some((c) => c.afterDeploy === true)).toBe(true);
  });
});
