import { describe, expect, it } from 'vitest';

import fullConfig from '../../vitest.config.js';
import { browserSmokeTests } from '../../vitest.browser-smoke.js';
import spaConfig from '../../vitest.spa-smoke.config.js';
import unitConfig from '../../vitest.unit.config.js';

interface StaticVitestConfig {
  test?: {
    include?: string[];
    exclude?: string[];
  };
}

const staticConfig = (value: unknown): StaticVitestConfig => value as StaticVitestConfig;

describe('browser smoke suite partition', () => {
  it('keeps every browser smoke out of the browserless full and unit suites', () => {
    const fullExclude = staticConfig(fullConfig).test?.exclude ?? [];
    const unitExclude = staticConfig(unitConfig).test?.exclude ?? [];

    for (const testPath of browserSmokeTests) {
      expect(fullExclude).toContain(testPath);
      expect(unitExclude).toContain(testPath);
    }
  });

  it('runs the complete browser smoke list only through the explicit SPA suite', () => {
    expect(staticConfig(spaConfig).test?.include).toEqual([...browserSmokeTests]);
  });
});
