#!/usr/bin/env node
/**
 * Generate docs/agent-readiness/feature-map.md from live phone-SPA chrome,
 * WORKFLOW L2 evidence scenes, and the L2 control-plane fixture seed.
 *
 * Docs + fixture only — does not add or rename data-evidence hosts in src/.
 *
 *   node scripts/feature-map.mjs          # write the doc
 *   node scripts/feature-map.mjs --check  # exit 1 when committed doc is stale
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';

export const FEATURE_MAP_DOC = 'docs/agent-readiness/feature-map.md';

const WEB_ROOT = 'src/web';
const WORKFLOW_PATH = 'WORKFLOW.md';
const FIXTURE_PATH = 'scripts/l2-seed-control-fixture.mjs';

/**
 * @typedef {{ anchor: string; file: string; dynamic: boolean }} FeatureMapAnchor
 * @typedef {{ name: string; steps: string[]; anchors: string[]; taskIds: string[] }} FeatureMapScene
 * @typedef {{
 *   anchors: FeatureMapAnchor[];
 *   scenes: FeatureMapScene[];
 *   fixtureTaskIds: string[];
 *   unknownAnchors: string[];
 *   unknownTaskIds: string[];
 * }} FeatureMapModel
 */

/**
 * @param {string} repoRoot
 * @returns {Promise<FeatureMapModel>}
 */
export async function collectFeatureMap(repoRoot) {
  const root = resolve(repoRoot);
  const anchors = await scanWebAnchors(root);
  const scenes = await parseWorkflowScenes(root);
  const fixtureTaskIds = await scanFixtureTaskIds(root);

  const sceneAnchors = uniqueSorted(scenes.flatMap((s) => s.anchors));
  const sceneTaskIds = uniqueSorted(scenes.flatMap((s) => s.taskIds));

  const unknownAnchors = sceneAnchors.filter(
    (a) => !anchorResolves(a, anchors),
  );
  const fixtureSet = new Set(fixtureTaskIds);
  const unknownTaskIds = sceneTaskIds.filter((id) => !fixtureSet.has(id));

  return {
    anchors,
    scenes,
    fixtureTaskIds,
    unknownAnchors,
    unknownTaskIds,
  };
}

/**
 * @param {FeatureMapModel} model
 * @returns {string}
 */
export function renderFeatureMap(model) {
  const staticCount = model.anchors.filter((a) => !a.dynamic).length;
  const dynamicCount = model.anchors.filter((a) => a.dynamic).length;
  const uniqueAnchorNames = uniqueSorted(model.anchors.map((a) => a.anchor));
  const coveredCount = uniqueAnchorNames.filter((name) =>
    isChromeCovered(name, model),
  ).length;

  const lines = [];
  lines.push('# Hercules feature map (generated)');
  lines.push('');
  lines.push(
    'Do not hand-edit — run `pnpm feature-map` (or `node scripts/feature-map.mjs`).',
  );
  lines.push('');
  lines.push('| Metric | Count |');
  lines.push('|--------|------:|');
  lines.push(`| Anchors (static) | ${staticCount} |`);
  lines.push(`| Anchors (dynamic) | ${dynamicCount} |`);
  lines.push(`| Scenes | ${model.scenes.length} |`);
  lines.push(`| Covered anchors | ${coveredCount} |`);
  lines.push(`| Unknown anchors | ${model.unknownAnchors.length} |`);
  lines.push(`| Unknown task ids | ${model.unknownTaskIds.length} |`);
  lines.push('');

  lines.push('## L2 scenes');
  lines.push('');
  for (const scene of model.scenes) {
    lines.push(`### ${scene.name}`);
    lines.push('');
    for (const step of scene.steps) {
      lines.push(`- ${step}`);
    }
    lines.push('');
  }

  lines.push('## Chrome by area');
  lines.push('');
  const byArea = groupAnchorsByArea(model.anchors);
  const areaKeys = Object.keys(byArea).sort((a, b) => a.localeCompare(b));
  for (const area of areaKeys) {
    lines.push(`### ${area}`);
    lines.push('');
    lines.push('| anchor | file(s) | covered |');
    lines.push('|--------|---------|---------|');
    /** @type {Map<string, { files: Set<string>; dynamic: boolean }>} */
    const rows = new Map();
    for (const entry of byArea[area] ?? []) {
      let row = rows.get(entry.anchor);
      if (!row) {
        row = { files: new Set(), dynamic: entry.dynamic };
        rows.set(entry.anchor, row);
      }
      row.files.add(entry.file);
      row.dynamic = row.dynamic || entry.dynamic;
    }
    const anchorNames = [...rows.keys()].sort((a, b) => a.localeCompare(b));
    for (const name of anchorNames) {
      const row = rows.get(name);
      if (!row) continue;
      const files = [...row.files].sort((a, b) => a.localeCompare(b)).join(', ');
      const covered = isChromeCovered(name, model) ? '✅' : '◻';
      lines.push(`| \`${name}\` | ${files} | ${covered} |`);
    }
    lines.push('');
  }

  lines.push('## Stale / unknown');
  lines.push('');
  lines.push('### Unknown anchors');
  lines.push('');
  if (model.unknownAnchors.length === 0) {
    lines.push('_none_');
  } else {
    for (const a of model.unknownAnchors) {
      lines.push(`- \`${a}\``);
    }
  }
  lines.push('');
  lines.push('### Unknown task ids');
  lines.push('');
  if (model.unknownTaskIds.length === 0) {
    lines.push('_none_');
  } else {
    for (const id of model.unknownTaskIds) {
      lines.push(`- \`${id}\``);
    }
  }
  lines.push('');

  // Trailing blank line after the final section (join alone would end on `_none_\n`).
  return `${lines.join('\n')}\n`;
}

// --- collectors -----------------------------------------------------------

/**
 * @param {string} root
 * @returns {Promise<FeatureMapAnchor[]>}
 */
async function scanWebAnchors(root) {
  const webDir = join(root, WEB_ROOT);
  const files = await listSourceFiles(webDir);
  /** @type {FeatureMapAnchor[]} */
  const out = [];

  for (const abs of files) {
    const rel = toPosix(relative(root, abs));
    const text = await readFile(abs, 'utf8');
    for (const hit of extractEvidenceAnchors(text)) {
      out.push({ anchor: hit.anchor, file: rel, dynamic: hit.dynamic });
    }
  }

  out.sort((a, b) => {
    const byAnchor = a.anchor.localeCompare(b.anchor);
    if (byAnchor !== 0) return byAnchor;
    return a.file.localeCompare(b.file);
  });
  return out;
}

/**
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function listSourceFiles(dir) {
  /** @type {string[]} */
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    if (code === 'ENOENT') return out;
    throw err;
  }
  for (const ent of entries) {
    const abs = join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...(await listSourceFiles(abs)));
      continue;
    }
    if (!ent.isFile()) continue;
    if (/\.test\./.test(ent.name)) continue;
    if (!/\.(tsx|ts)$/.test(ent.name)) continue;
    out.push(abs);
  }
  return out;
}

/**
 * @param {string} source
 * @returns {Array<{ anchor: string; dynamic: boolean }>}
 */
function extractEvidenceAnchors(source) {
  /** @type {Array<{ anchor: string; dynamic: boolean }>} */
  const hits = [];
  const re = /data-evidence\s*=\s*/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const start = m.index + m[0].length;
    const parsed = parseEvidenceValue(source, start);
    if (!parsed) continue;
    for (const hit of parsed.hits) {
      hits.push(hit);
    }
    // Avoid re-matching inside the value we just consumed.
    re.lastIndex = Math.max(parsed.end, start + 1);
  }
  return hits;
}

/**
 * @param {string} source
 * @param {number} start
 * @returns {{ hits: Array<{ anchor: string; dynamic: boolean }>; end: number } | null}
 */
function parseEvidenceValue(source, start) {
  if (start >= source.length) return null;
  const ch = source[start];

  if (ch === '"' || ch === "'") {
    const lit = readQuoted(source, start);
    if (!lit) return null;
    return {
      hits: [{ anchor: lit.value, dynamic: false }],
      end: lit.end,
    };
  }

  if (ch === '{') {
    const close = findMatchingBrace(source, start);
    if (close < 0) return null;
    const inner = source.slice(start + 1, close).trim();
    const hits = parseBraceEvidence(inner);
    return { hits, end: close + 1 };
  }

  return null;
}

/**
 * @param {string} inner
 * @returns {Array<{ anchor: string; dynamic: boolean }>}
 */
function parseBraceEvidence(inner) {
  const trimmed = inner.trim();
  if (!trimmed) return [];

  if (trimmed[0] === '"' || trimmed[0] === "'") {
    const lit = readQuoted(trimmed, 0);
    if (lit && lit.end === trimmed.length) {
      return [{ anchor: lit.value, dynamic: false }];
    }
    // Fall through: may be a ternary that starts with a string (unlikely).
  }

  if (trimmed[0] === '`') {
    const tmpl = readTemplate(trimmed, 0);
    if (tmpl) {
      return [templateToHit(tmpl.value)];
    }
  }

  // Ternary / expression: record string literals inside the braces (both
  // arms of `cond ? 'a' : 'b'`). Skip literals that are comparison operands
  // (`=== 'accepted'`) so only evidence hosts are mapped.
  /** @type {Array<{ anchor: string; dynamic: boolean }>} */
  const hits = [];
  let i = 0;
  while (i < trimmed.length) {
    const c = trimmed[i];
    if (c === '"' || c === "'") {
      const lit = readQuoted(trimmed, i);
      if (!lit) break;
      if (!isComparisonOperand(trimmed, i)) {
        hits.push({ anchor: lit.value, dynamic: false });
      }
      i = lit.end;
      continue;
    }
    if (c === '`') {
      const tmpl = readTemplate(trimmed, i);
      if (!tmpl) break;
      hits.push(templateToHit(tmpl.value));
      i = tmpl.end;
      continue;
    }
    i += 1;
  }
  return hits;
}

/**
 * @param {string} source
 * @param {number} litStart
 */
function isComparisonOperand(source, litStart) {
  const before = source.slice(0, litStart).replace(/\s+$/u, '');
  return /(===|!==|==|!=)$/.test(before);
}

/**
 * @param {string} raw
 * @returns {{ anchor: string; dynamic: boolean }}
 */
function templateToHit(raw) {
  const dollar = raw.indexOf('${');
  if (dollar >= 0) {
    return { anchor: `${raw.slice(0, dollar)}*`, dynamic: true };
  }
  return { anchor: raw, dynamic: false };
}

/**
 * @param {string} source
 * @param {number} openIdx index of '{'
 * @returns {number} index of matching '}' or -1
 */
function findMatchingBrace(source, openIdx) {
  let depth = 0;
  let i = openIdx;
  let mode = 'code'; // code | sq | dq | tmpl | line | block
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];

    if (mode === 'line') {
      if (c === '\n') mode = 'code';
      i += 1;
      continue;
    }
    if (mode === 'block') {
      if (c === '*' && next === '/') {
        mode = 'code';
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (mode === 'sq') {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === "'") mode = 'code';
      i += 1;
      continue;
    }
    if (mode === 'dq') {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === '"') mode = 'code';
      i += 1;
      continue;
    }
    if (mode === 'tmpl') {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === '`') {
        mode = 'code';
        i += 1;
        continue;
      }
      if (c === '$' && next === '{') {
        // Nested expression inside template: scan balanced braces in code mode.
        i += 2;
        let nest = 1;
        let nestMode = 'code';
        while (i < source.length && nest > 0) {
          const nc = source[i];
          if (nestMode === 'sq') {
            if (nc === '\\') {
              i += 2;
              continue;
            }
            if (nc === "'") nestMode = 'code';
            i += 1;
            continue;
          }
          if (nestMode === 'dq') {
            if (nc === '\\') {
              i += 2;
              continue;
            }
            if (nc === '"') nestMode = 'code';
            i += 1;
            continue;
          }
          if (nestMode === 'tmpl') {
            if (nc === '\\') {
              i += 2;
              continue;
            }
            if (nc === '`') nestMode = 'code';
            i += 1;
            continue;
          }
          if (nc === "'" ) {
            nestMode = 'sq';
            i += 1;
            continue;
          }
          if (nc === '"') {
            nestMode = 'dq';
            i += 1;
            continue;
          }
          if (nc === '`') {
            nestMode = 'tmpl';
            i += 1;
            continue;
          }
          if (nc === '{') nest += 1;
          else if (nc === '}') nest -= 1;
          i += 1;
        }
        continue;
      }
      i += 1;
      continue;
    }

    // code
    if (c === '/' && next === '/') {
      mode = 'line';
      i += 2;
      continue;
    }
    if (c === '/' && next === '*') {
      mode = 'block';
      i += 2;
      continue;
    }
    if (c === "'") {
      mode = 'sq';
      i += 1;
      continue;
    }
    if (c === '"') {
      mode = 'dq';
      i += 1;
      continue;
    }
    if (c === '`') {
      mode = 'tmpl';
      i += 1;
      continue;
    }
    if (c === '{') {
      depth += 1;
      i += 1;
      continue;
    }
    if (c === '}') {
      depth -= 1;
      if (depth === 0) return i;
      i += 1;
      continue;
    }
    i += 1;
  }
  return -1;
}

/**
 * @param {string} source
 * @param {number} start index of opening quote
 * @returns {{ value: string; end: number } | null}
 */
function readQuoted(source, start) {
  const quote = source[start];
  if (quote !== '"' && quote !== "'") return null;
  let i = start + 1;
  let value = '';
  while (i < source.length) {
    const c = source[i];
    if (c === '\\') {
      value += source[i + 1] ?? '';
      i += 2;
      continue;
    }
    if (c === quote) {
      return { value, end: i + 1 };
    }
    value += c;
    i += 1;
  }
  return null;
}

/**
 * @param {string} source
 * @param {number} start index of opening backtick
 * @returns {{ value: string; end: number } | null}
 */
function readTemplate(source, start) {
  if (source[start] !== '`') return null;
  let i = start + 1;
  let value = '';
  while (i < source.length) {
    const c = source[i];
    if (c === '\\') {
      value += source[i + 1] ?? '';
      i += 2;
      continue;
    }
    if (c === '`') {
      return { value, end: i + 1 };
    }
    value += c;
    i += 1;
  }
  return null;
}

/**
 * @param {string} root
 * @returns {Promise<FeatureMapScene[]>}
 */
async function parseWorkflowScenes(root) {
  const text = await readFile(join(root, WORKFLOW_PATH), 'utf8');
  const fm = extractFrontMatter(text);
  const doc = parseYaml(fm);
  const evidence = doc?.behavioral?.evidence;
  if (!Array.isArray(evidence)) return [];

  /** @type {FeatureMapScene[]} */
  const scenes = [];
  /** @type {string[]} */
  let steps = [];
  /** @type {string[]} */
  let anchors = [];
  /** @type {string[]} */
  let taskIds = [];

  const flush = (name) => {
    scenes.push({
      name,
      steps: [...steps],
      anchors: uniqueSorted(anchors),
      taskIds: uniqueSorted(taskIds),
    });
    steps = [];
    anchors = [];
    taskIds = [];
  };

  for (const raw of evidence) {
    const { line, foundAnchors, foundTaskIds } = describeEvidenceStep(raw);
    steps.push(line);
    anchors.push(...foundAnchors);
    taskIds.push(...foundTaskIds);

    if (
      raw &&
      typeof raw === 'object' &&
      !Array.isArray(raw) &&
      Object.prototype.hasOwnProperty.call(raw, 'screenshot')
    ) {
      const name = String(/** @type {{ screenshot: unknown }} */ (raw).screenshot);
      flush(name);
    }
  }

  if (steps.length > 0) {
    flush('(no screenshot)');
  }

  return scenes;
}

/**
 * @param {string} text
 * @returns {string}
 */
function extractFrontMatter(text) {
  if (!text.startsWith('---')) {
    throw new Error('WORKFLOW.md: missing opening front matter delimiter');
  }
  const end = text.indexOf('\n---', 3);
  if (end < 0) {
    throw new Error('WORKFLOW.md: missing closing front matter delimiter');
  }
  return text.slice(4, end + 1); // drop leading ---\n, keep through last fm line
}

/**
 * @param {unknown} raw
 * @returns {{ line: string; foundAnchors: string[]; foundTaskIds: string[] }}
 */
function describeEvidenceStep(raw) {
  /** @type {string[]} */
  const foundAnchors = [];
  /** @type {string[]} */
  const foundTaskIds = [];

  const collectFromSelector = (sel) => {
    if (typeof sel !== 'string') return;
    const re = /\[data-(evidence|task-id)=([A-Za-z0-9._-]+)\]/g;
    let m;
    while ((m = re.exec(sel)) !== null) {
      if (m[1] === 'evidence') foundAnchors.push(m[2] ?? '');
      else foundTaskIds.push(m[2] ?? '');
    }
  };

  if (raw === 'unlock') {
    return { line: 'unlock', foundAnchors, foundTaskIds };
  }

  if (typeof raw === 'string') {
    collectFromSelector(raw);
    return { line: raw, foundAnchors, foundTaskIds };
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { line: JSON.stringify(raw), foundAnchors, foundTaskIds };
  }

  const obj = /** @type {Record<string, unknown>} */ (raw);

  if (typeof obj.click === 'string') {
    collectFromSelector(obj.click);
    return { line: `click ${obj.click}`, foundAnchors, foundTaskIds };
  }

  if (Object.prototype.hasOwnProperty.call(obj, 'screenshot')) {
    return {
      line: `screenshot ${String(obj.screenshot)}`,
      foundAnchors,
      foundTaskIds,
    };
  }

  if (Object.prototype.hasOwnProperty.call(obj, 'assert')) {
    const assertVal = obj.assert;
    if (assertVal && typeof assertVal === 'object' && !Array.isArray(assertVal)) {
      const a = /** @type {Record<string, unknown>} */ (assertVal);
      if (typeof a.selector === 'string') {
        collectFromSelector(a.selector);
        return {
          line: `assert selector ${a.selector}`,
          foundAnchors,
          foundTaskIds,
        };
      }
      if (typeof a.text === 'string') {
        return {
          line: `assert text ${a.text}`,
          foundAnchors,
          foundTaskIds,
        };
      }
    }
    if (typeof assertVal === 'string') {
      collectFromSelector(assertVal);
      return { line: `assert ${assertVal}`, foundAnchors, foundTaskIds };
    }
    return {
      line: `assert ${JSON.stringify(assertVal)}`,
      foundAnchors,
      foundTaskIds,
    };
  }

  return { line: JSON.stringify(raw), foundAnchors, foundTaskIds };
}

/**
 * @param {string} root
 * @returns {Promise<string[]>}
 */
async function scanFixtureTaskIds(root) {
  const text = await readFile(join(root, FIXTURE_PATH), 'utf8');
  /** @type {Set<string>} */
  const ids = new Set();

  for (const m of text.matchAll(/\bid:\s*'([^']+)'/g)) {
    if (m[1]) ids.add(m[1]);
  }
  for (const m of text.matchAll(/\bid:\s*"([^"]+)"/g)) {
    if (m[1]) ids.add(m[1]);
  }
  for (const m of text.matchAll(/l2-fixture-[A-Za-z0-9-]+/g)) {
    ids.add(m[0]);
  }
  // M7 outcome-review tasks are seeded as ['l2-m7-pass', …] tuples (not
  // `id: '…'` object properties). Include those quoted literals so
  // unknownTaskIds reflects real fixture coverage.
  for (const m of text.matchAll(/['"](l2-m7-[A-Za-z0-9-]+)['"]/g)) {
    if (m[1]) ids.add(m[1]);
  }

  return [...ids].sort((a, b) => a.localeCompare(b));
}

// --- coverage helpers -----------------------------------------------------

/**
 * @param {string} sceneAnchor
 * @param {FeatureMapAnchor[]} anchors
 */
function anchorResolves(sceneAnchor, anchors) {
  for (const a of anchors) {
    if (!a.dynamic && a.anchor === sceneAnchor) return true;
    if (a.dynamic && a.anchor.endsWith('*')) {
      const prefix = a.anchor.slice(0, -1);
      if (sceneAnchor.startsWith(prefix)) return true;
    }
  }
  return false;
}

/**
 * @param {string} chromeAnchor
 * @param {FeatureMapModel} model
 */
function isChromeCovered(chromeAnchor, model) {
  const sceneAnchors = model.scenes.flatMap((s) => s.anchors);
  if (sceneAnchors.includes(chromeAnchor)) return true;
  if (chromeAnchor.endsWith('*')) {
    const prefix = chromeAnchor.slice(0, -1);
    return sceneAnchors.some((sa) => sa.startsWith(prefix));
  }
  // Static chrome covered when a scene references it via a matching dynamic? no —
  // only exact scene reference (already checked) or when scene has the exact name.
  return false;
}

/**
 * @param {FeatureMapAnchor[]} anchors
 * @returns {Record<string, FeatureMapAnchor[]>}
 */
function groupAnchorsByArea(anchors) {
  /** @type {Record<string, FeatureMapAnchor[]>} */
  const out = {};
  for (const a of anchors) {
    const dash = a.anchor.indexOf('-');
    const area = dash >= 0 ? a.anchor.slice(0, dash) : a.anchor;
    if (!out[area]) out[area] = [];
    out[area].push(a);
  }
  return out;
}

/**
 * @param {string[]} items
 * @returns {string[]}
 */
function uniqueSorted(items) {
  return [...new Set(items.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

/**
 * @param {string} p
 */
function toPosix(p) {
  return p.split(sep).join('/');
}

// --- CLI ------------------------------------------------------------------

/**
 * @param {string[]} argv
 */
async function main(argv) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const check = argv.includes('--check');
  const model = await collectFeatureMap(repoRoot);
  const rendered = renderFeatureMap(model);
  const docPath = join(repoRoot, FEATURE_MAP_DOC);

  if (check) {
    let existing = '';
    try {
      existing = await readFile(docPath, 'utf8');
    } catch {
      existing = '';
    }
    if (existing !== rendered) {
      console.error('run: pnpm feature-map');
      process.exitCode = 1;
      return;
    }
    return;
  }

  await writeFile(docPath, rendered, 'utf8');
  process.stdout.write(`wrote ${FEATURE_MAP_DOC}\n`);
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
