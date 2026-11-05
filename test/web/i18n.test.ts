/**
 * UI strings for en/zh — Settings and primary chrome must cover both languages.
 */
import { describe, it, expect } from 'vitest';
import { t, type MessageKey } from '../../src/web/i18n.js';

const REQUIRED: MessageKey[] = [
  'navTasks',
  'navChat',
  'navRepos',
  'navReleases',
  'navSettings',
  'releasesTitle',
  'releasesPromote',
  'releasesPromoteConfirm',
  'releasesRollback',
  'releasesRollbackConfirm',
  'settingsTitle',
  'settingsLanguage',
  'settingsLangEn',
  'settingsLangZh',
  'settingsDefaultAgent',
  'settingsDefaultAgentHint',
  'settingsInheritDaemon',
  'settingsLogout',
  'settingsLogoutConfirm',
  'settingsDaemonDefault',
  'settingsUpdateTitle',
  'settingsUpdateHint',
  'settingsUpdate',
  'settingsUpdateConfirm',
  'settingsUpdateRunning',
  'settingsUpdateDisabled',
  'settingsUpdateOk',
  'settingsUpdateFailed',
  'settingsUpdateLog',
  'settingsCostBillingMode',
  'settingsCostModeSubscription',
  'settingsCostModeMetered',
  'settingsCostThresholds',
  'settingsCostTaskLabel',
  'settingsCostDayLabel',
  'settingsCostMeaningSubscription',
  'settingsCostMeaningMetered',
  'settingsCostBillingModeFallback',
  'repoFilterAria',
  'repoFilterAll',
  'repoFilterEmpty',
  'taskSearchAria',
  'taskSearchPlaceholder',
  'taskSearchEmpty',
];

describe('i18n', () => {
  it('provides en and zh for Settings + nav keys', () => {
    for (const key of REQUIRED) {
      const en = t('en', key);
      const zh = t('zh', key);
      expect(en.length, `en.${key}`).toBeGreaterThan(0);
      expect(zh.length, `zh.${key}`).toBeGreaterThan(0);
      // Chinese copy should differ from English for real labels (not pure icons).
      if (key !== 'settingsLangEn' && key !== 'settingsLangZh') {
        expect(zh, `${key} zh should differ from en`).not.toBe(en);
      }
    }
  });

  it('English Settings title is Settings; Chinese is 设置', () => {
    expect(t('en', 'settingsTitle')).toBe('Settings');
    expect(t('zh', 'settingsTitle')).toMatch(/设置/);
    expect(t('en', 'navSettings')).toBe('Settings');
    expect(t('zh', 'navSettings')).toMatch(/设置/);
  });

  it('Logout labels exist in both languages', () => {
    expect(t('en', 'settingsLogout')).toMatch(/Logout|Sign out/i);
    expect(t('zh', 'settingsLogout')).toMatch(/退出|登出/);
  });
});
