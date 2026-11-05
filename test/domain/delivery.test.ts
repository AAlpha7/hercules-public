import { describe, it, expect } from 'vitest';
import {
  assessDeliveryHonesty,
  deliveryExpectation,
  findFalseDeliveryClaims,
  hasNoDiffOkMarker,
  stripReviewAndSteerSections,
} from '../../src/domain/delivery.js';

describe('delivery honesty (system non-result detection)', () => {
  it('strips prior review packets when judging task intent', () => {
    const body = `页面改成设置\n\n## Review packet\n\n### x\n设置页已上线`;
    expect(stripReviewAndSteerSections(body)).toBe('页面改成设置');
  });

  it('honors hercules:no-diff-ok and analysis labels', () => {
    expect(hasNoDiffOkMarker('hello <!-- hercules:no-diff-ok -->')).toBe(true);
    expect(hasNoDiffOkMarker('plain', ['analysis'])).toBe(true);
    expect(hasNoDiffOkMarker('实现设置页')).toBe(false);
  });

  it('expects file changes for implementer UI tasks', () => {
    expect(
      deliveryExpectation({
        title: 'Logout页面改成设置页面',
        body: '页面里面加几个功能：语言、默认agent、Logout',
        runKind: 'implementer',
      }),
    ).toBe('file-changes');
  });

  it('allows no-diff for analysis titles; implement intent wins over steer', () => {
    // Case study logout: "ready了吗" was runKind=steer but task is still Settings UI.
    expect(
      deliveryExpectation({
        title: 'Logout页面改成设置页面',
        body: '页面里面加几个功能：语言、默认agent、Logout',
        runKind: 'steer',
      }),
    ).toBe('file-changes');
    expect(
      deliveryExpectation({
        title: '分析一下架构',
        body: '只做调研',
        runKind: 'implementer',
      }),
    ).toBe('no-diff-ok');
    // Pure steer on a non-implement task title may stay no-diff.
    expect(
      deliveryExpectation({
        title: 'ops check-in',
        body: 'status only',
        runKind: 'steer',
      }),
    ).toBe('no-diff-ok');
  });

  it('detects false delivery claims', () => {
    expect(findFalseDeliveryClaims('设置页已上线：底部 **设置**')).toContain('设置页已');
    expect(findFalseDeliveryClaims('Settings 功能已落地').join(' ')).toMatch(/功能已落地/);
    expect(findFalseDeliveryClaims('nothing special')).toEqual([]);
  });

  it('fails implementer empty-diff UI task (auto-rework)', () => {
    const a = assessDeliveryHonesty({
      title: 'Logout页面改成设置页面',
      body: '加语言和默认agent',
      runKind: 'implementer',
      noFileChanges: true,
      finalReport: 'done',
    });
    expect(a.deliveryFailed).toBe(true);
    expect(a.autoRework).toBe(true);
    expect(a.reason).toMatch(/expects file changes|empty/i);
  });

  it('fails empty-diff implement task on steer even when agent admits not ready', () => {
    // Honest "还没 ready" still must not park in human review with green gates.
    const a = assessDeliveryHonesty({
      title: 'Logout页面改成设置页面',
      body: '页面里面加几个功能：语言（中/英）、默认agent、Logout',
      runKind: 'steer',
      noFileChanges: true,
      finalReport: '**还没 ready。** 当前分支仍是底栏 Logout，没有设置页。',
    });
    expect(a.expectation).toBe('file-changes');
    expect(a.deliveryFailed).toBe(true);
    expect(a.autoRework).toBe(true);
  });

  it('fails empty-diff with shipped claim even on steer', () => {
    const a = assessDeliveryHonesty({
      title: 'follow up',
      body: 'Talk local',
      runKind: 'steer',
      noFileChanges: true,
      finalReport: '设置页已上线：底部 **设置** 里可切换中/英',
    });
    expect(a.deliveryFailed).toBe(true);
    expect(a.autoRework).toBe(true);
    expect(a.claimHits.length).toBeGreaterThan(0);
  });

  it('allows honest steer no-diff only when task is not an implement ask', () => {
    const a = assessDeliveryHonesty({
      title: 'ops check-in',
      body: 'Talk her local. Ask.',
      runKind: 'steer',
      noFileChanges: true,
      finalReport: 'Asked the user about language preference; waiting for reply.',
    });
    expect(a.deliveryFailed).toBe(false);
    expect(a.autoRework).toBe(false);
  });
});
