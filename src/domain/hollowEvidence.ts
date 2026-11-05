/**
 * Domain — hollow-evidence detection (identical screenshots across distinct
 * scenarios). Pure: no IO. Fail-closed for the behavioural axis.
 */

/** One screenshot / media artifact tagged with the scenario it claims to prove. */
export interface HollowEvidenceShot {
  /** Scenario key: L2 screenshot name, CLI step id, or hercules-scenario id. */
  readonly scenario: string;
  /** Lowercase hex sha256 of the bytes. */
  readonly sha256: string;
  /** Optional display name (basename). */
  readonly name?: string;
}

export interface HollowEvidenceHit {
  readonly sha256: string;
  readonly count: number;
  readonly scenarios: readonly string[];
  readonly names: readonly string[];
}

export interface HollowEvidenceReport {
  readonly hits: readonly HollowEvidenceHit[];
  /** Packet line when hits.length > 0. */
  readonly packetLine: string | null;
  readonly detail: string | null;
}

const HERCULES_SCENARIO_LINE_RE =
  /^hercules-scenario:\s*([A-Za-z0-9._-]+)(?:\s+surfaces=\S*)?\s*$/gm;

/** Extract distinct `hercules-scenario: <id>` values from CLI step stdout. */
export function extractHerculesScenarioIds(stdoutTail: string): readonly string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  HERCULES_SCENARIO_LINE_RE.lastIndex = 0;
  for (const m of stdoutTail.matchAll(HERCULES_SCENARIO_LINE_RE)) {
    const id = m[1];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/**
 * Collect L2 screenshot shots. Each screenshot step with a sha256 is its own
 * scenario (keyed by screenshot basename / step name). Identical bytes within
 * the same scenario key are ignored at the grouping stage.
 */
export function collectL2HollowShots(
  steps: readonly {
    readonly kind: string;
    readonly ok: boolean;
    readonly screenshot?: string;
    readonly screenshotSha256?: string;
    readonly raw?: string;
  }[],
): readonly HollowEvidenceShot[] {
  const out: HollowEvidenceShot[] = [];
  for (const st of steps) {
    if (st.kind !== 'screenshot' && !st.screenshot) continue;
    const sha = st.screenshotSha256?.trim().toLowerCase();
    if (!sha || !/^[a-f0-9]{64}$/.test(sha)) continue;
    const name = st.screenshot ?? 'screenshot';
    // Distinct L2 steps → distinct scenarios (screenshot name / raw label).
    const scenario =
      (st.raw && /^screenshot\s+(\S+)/i.exec(st.raw)?.[1]) ||
      (st.screenshot ? st.screenshot.replace(/\.[a-z0-9]+$/i, '') : null) ||
      name;
    out.push({ scenario, sha256: sha, name });
  }
  return out;
}

/**
 * Collect CLI artifact shots across steps. Artifacts from different step ids
 * are distinct scenarios. When one step's stdout declares ≥2 hercules-scenario
 * ids, image artifacts are attributed round-robin / by name match to those
 * scenarios (identical bytes across those attributions are hollow).
 */
export function collectCliHollowShots(
  steps: readonly {
    readonly id: string;
    readonly stdoutTail: string;
    readonly artifacts?: readonly {
      readonly name: string;
      readonly kind: 'image' | 'video';
      readonly sha256: string;
    }[];
  }[],
): readonly HollowEvidenceShot[] {
  const out: HollowEvidenceShot[] = [];
  for (const step of steps) {
    const arts = (step.artifacts ?? []).filter(
      (a) => a.kind === 'image' && /^[a-f0-9]{64}$/i.test(a.sha256),
    );
    if (arts.length === 0) continue;
    const scenarioIds = extractHerculesScenarioIds(step.stdoutTail);
    if (scenarioIds.length >= 2 && arts.length >= 2) {
      // Attribute artifacts to declared scenarios: name-contains-id first,
      // then positional pairing for the remainder.
      const used = new Set<number>();
      for (const sid of scenarioIds) {
        const idx = arts.findIndex(
          (a, i) => !used.has(i) && a.name.toLowerCase().includes(sid.toLowerCase()),
        );
        if (idx >= 0) {
          used.add(idx);
          const a = arts[idx]!;
          out.push({
            scenario: sid,
            sha256: a.sha256.toLowerCase(),
            name: a.name,
          });
        }
      }
      let pos = 0;
      for (let i = 0; i < arts.length; i += 1) {
        if (used.has(i)) continue;
        const sid = scenarioIds[pos % scenarioIds.length]!;
        pos += 1;
        const a = arts[i]!;
        out.push({
          scenario: sid,
          sha256: a.sha256.toLowerCase(),
          name: a.name,
        });
      }
    } else {
      // One scenario per CLI step — identical shots within the step are fine.
      for (const a of arts) {
        out.push({
          scenario: step.id,
          sha256: a.sha256.toLowerCase(),
          name: a.name,
        });
      }
    }
  }
  return out;
}

/**
 * Hollow evidence — a scenario whose screenshots are copies of another
 * scenario's.
 *
 * Two scenario shapes, judged separately (2026-09-10, a downstream project
 * work-select-verify false positive: every recorded scenario opens `/ui/`
 * and shoots the home surface first, so identical FIRST frames across
 * scenarios are expected):
 * - **Single-shot scenarios** (L2 `screenshot` steps, CLI steps with one
 *   image): identical sha256 across ≥2 distinct scenario keys is hollow
 *   (`login.png` == `settings.png` — the original incident).
 * - **Multi-shot scenarios** (CLI artifacts attributed to a scenario): the
 *   first shot is the landing frame and is ignored; the scenario is hollow
 *   only when the set of its remaining shots is exactly another multi-shot
 *   scenario's remaining set — a nested flow (one scenario's shots being a
 *   subset of a longer one) is not hollow.
 * Same scenario may legally share bytes (re-captures within one step).
 */
export function detectHollowEvidence(
  shots: readonly HollowEvidenceShot[],
): HollowEvidenceReport {
  const byScenario = new Map<string, HollowEvidenceShot[]>();
  for (const shot of shots) {
    const row = byScenario.get(shot.scenario);
    if (row) row.push(shot);
    else byScenario.set(shot.scenario, [shot]);
  }
  const byHash = new Map<
    string,
    { scenarios: Set<string>; names: string[]; count: number }
  >();
  const record = (shot: HollowEvidenceShot): void => {
    let row = byHash.get(shot.sha256);
    if (!row) {
      row = { scenarios: new Set(), names: [], count: 0 };
      byHash.set(shot.sha256, row);
    }
    row.scenarios.add(shot.scenario);
    row.count += 1;
    if (shot.name && !row.names.includes(shot.name)) row.names.push(shot.name);
  };
  // Single-shot scenarios: the original cross-scenario rule.
  const single = [...byScenario.entries()].filter(([, list]) => list.length === 1);
  const singleByHash = new Map<string, HollowEvidenceShot[]>();
  for (const [, list] of single) {
    const shot = list[0]!;
    const row = singleByHash.get(shot.sha256);
    if (row) row.push(shot);
    else singleByHash.set(shot.sha256, [shot]);
  }
  for (const list of singleByHash.values()) {
    if (new Set(list.map((s) => s.scenario)).size < 2) continue;
    for (const shot of list) record(shot);
  }
  // Multi-shot scenarios: landing frame ignored; exact duplicate rest-sets.
  const multi = [...byScenario.entries()]
    .filter(([, list]) => list.length >= 2)
    .map(([scenario, list]) => ({
      scenario,
      rest: list.slice(1),
      key: [...new Set(list.slice(1).map((s) => s.sha256))].sort().join(','),
    }));
  const byRestKey = new Map<string, typeof multi>();
  for (const entry of multi) {
    const row = byRestKey.get(entry.key);
    if (row) row.push(entry);
    else byRestKey.set(entry.key, [entry]);
  }
  for (const group of byRestKey.values()) {
    if (group.length < 2) continue;
    for (const entry of group) for (const shot of entry.rest) record(shot);
  }
  const hits: HollowEvidenceHit[] = [];
  for (const [sha256, row] of byHash) {
    if (row.scenarios.size < 2) continue;
    hits.push({
      sha256,
      count: row.count,
      scenarios: [...row.scenarios].sort(),
      names: row.names.length > 0 ? row.names : [...row.scenarios],
    });
  }
  hits.sort((a, b) => a.sha256.localeCompare(b.sha256));
  if (hits.length === 0) {
    return { hits: [], packetLine: null, detail: null };
  }
  const totalShots = hits.reduce((n, h) => n + h.count, 0);
  const scenarioNames = [...new Set(hits.flatMap((h) => h.scenarios))].sort();
  const nameList = scenarioNames.join(', ');
  const packetLine =
    `❌ hollow evidence — ${String(totalShots)} screenshots identical across scenarios (${nameList})`;
  const detail =
    `hollow-evidence: ${String(totalShots)} identical screenshots across scenarios (${nameList})`;
  return { hits, packetLine, detail };
}

/** Marker prefix written into L2 step detail when hollow evidence is detected. */
export const HOLLOW_EVIDENCE_DETAIL_PREFIX = 'hollow evidence —';
