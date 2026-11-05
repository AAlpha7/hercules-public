/** Build / serialize / authority for advisory proposed graph packets. */
import {
  TaskGraphValidationError,
  parseTaskGraph,
  serializeTaskGraph,
  taskGraphDigest,
  validateTaskGraph,
  type TaskGraph,
  type TaskGraphValidationIssue,
} from './taskGraph.js';
import {
  MAX_PROPOSED_GRAPH_NOTES_LEN,
  MAX_PROPOSED_GRAPH_PACKET_BYTES,
  MAX_PROPOSED_GRAPH_UNKNOWN_LEN,
  MAX_PROPOSED_GRAPH_UNKNOWNS,
  PROPOSED_GRAPH_PACKET_BLOCK_END,
  PROPOSED_GRAPH_PACKET_BLOCK_START,
  PROPOSED_GRAPH_PACKET_HEADING,
  PROPOSED_GRAPH_PACKET_VERSION,
  ProposedGraphPacketError,
  extractDeclaredUnknowns,
  mergeUnknowns,
  extractOperatorDecisions,
  extractProofCommands,
  proposedGraphPacketDigest,
  redactProposedGraphText,
  type ProposedGraphPacket,
  type ProposedGraphPacketBuildResult,
  type ProposedGraphPacketParseResult,
  type ProposedGraphUnknown,
} from './proposedGraphPacket.js';

function extractInvestigationUnknowns(graph: TaskGraph): readonly ProposedGraphUnknown[] {
  const out: ProposedGraphUnknown[] = [];
  for (const n of graph.nodes) {
    if (n.kind !== 'investigation') continue;
    const text = redactProposedGraphText(
      n.goal.length > 0 ? n.goal : n.title,
      MAX_PROPOSED_GRAPH_UNKNOWN_LEN,
    );
    if (text.length === 0) continue;
    out.push({ source: 'investigation_node', text, nodeId: n.id });
    if (out.length >= MAX_PROPOSED_GRAPH_UNKNOWNS) break;
  }
  return out;
}

function isTaskGraphShaped(v: unknown): boolean {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return 'version' in o && 'id' in o && 'nodes' in o && 'edges' in o && 'integration' in o;
}

function resolvePlannerInput(input: unknown): {
  graphRaw: unknown;
  unknownsRaw: unknown;
  notesRaw: unknown;
} | { error: TaskGraphValidationIssue } {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { error: { code: 'schema', message: 'planner output must be an object' } };
  }
  const o = input as Record<string, unknown>;
  if (isTaskGraphShaped(input) && o['graph'] === undefined) {
    return { graphRaw: input, unknownsRaw: undefined, notesRaw: undefined };
  }
  if (o['graph'] === undefined || o['graph'] === null) {
    return {
      error: { code: 'schema', message: 'planner output is incomplete: graph is required' },
    };
  }
  return { graphRaw: o['graph'], unknownsRaw: o['unknowns'], notesRaw: o['notes'] };
}

export function buildProposedGraphPacket(input: unknown): ProposedGraphPacketBuildResult {
  const resolved = resolvePlannerInput(input);
  if ('error' in resolved) return { ok: false, errors: [resolved.error] };
  const validated = validateTaskGraph(resolved.graphRaw);
  if (!validated.ok) return { ok: false, errors: validated.errors };
  const graph = validated.graph;
  const unknowns = mergeUnknowns(
    extractDeclaredUnknowns(resolved.unknownsRaw),
    extractInvestigationUnknowns(graph),
  );
  let notes: string | null = null;
  if (typeof resolved.notesRaw === 'string' && resolved.notesRaw.trim().length > 0) {
    notes = redactProposedGraphText(resolved.notesRaw, MAX_PROPOSED_GRAPH_NOTES_LEN);
    if (notes.length === 0) notes = null;
  }
  const base = {
    version: PROPOSED_GRAPH_PACKET_VERSION,
    kind: 'proposed_graph' as const,
    mode: 'advisory' as const,
    verifiedWork: false as const,
    graph,
    graphDigest: taskGraphDigest(graph),
    unknowns,
    notes,
  };
  return { ok: true, packet: { ...base, packetDigest: proposedGraphPacketDigest(base) } };
}

function sortKeysDeep(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    const v = obj[key];
    if (v !== undefined) out[key] = sortKeysDeep(v);
  }
  return out;
}

export function serializeProposedGraphPacket(packet: ProposedGraphPacket): string {
  const body = {
    version: packet.version,
    kind: packet.kind,
    mode: packet.mode,
    verifiedWork: false as const,
    graph: JSON.parse(serializeTaskGraph(packet.graph)) as unknown,
    graphDigest: packet.graphDigest,
    unknowns: packet.unknowns,
    notes: packet.notes,
    packetDigest: packet.packetDigest,
  };
  return JSON.stringify(sortKeysDeep(body)) + '\n';
}

export function proposedGraphMayEnterScheduling(_input: unknown): false {
  return false;
}

export function proposedGraphAuthorizesDispatch(_packet: ProposedGraphPacket): false {
  return false;
}

export function proposedGraphAuthorizesChildTaskCreation(_packet: ProposedGraphPacket): false {
  return false;
}

function bullet(label: string, value: string): string {
  return '- **' + label + ':** ' + value;
}

/** Phone-readable markdown with embedded restart-safe JSON block. */
export function formatProposedGraphPacketMarkdown(packet: ProposedGraphPacket): string {
  const graph = packet.graph;
  const objective = graph.nodes.find((n) => n.id === graph.integration.objectiveNodeId);
  const proof = extractProofCommands(graph);
  const decisions = extractOperatorDecisions(graph, packet.unknowns);
  const gd = packet.graphDigest.slice(0, 12);
  const pd = packet.packetDigest.slice(0, 12);
  const lines: string[] = [
    PROPOSED_GRAPH_PACKET_HEADING,
    '',
    PROPOSED_GRAPH_PACKET_BLOCK_START,
    serializeProposedGraphPacket(packet).trimEnd(),
    PROPOSED_GRAPH_PACKET_BLOCK_END,
    '',
    '**Mode:** `advisory` — this is a proposed plan, not verified work.',
    'It does not create or dispatch child tasks and cannot enter scheduling.',
    '',
    bullet('Graph id', '`' + graph.id + '`'),
    bullet('Graph digest', '`' + gd + '…`'),
    bullet('Packet digest', '`' + pd + '…`'),
    bullet('Verified work', '`false`'),
    bullet('Rationale', graph.rationale || '_(none)_'),
    '',
    '### Objective',
    '',
  ];
  if (objective) {
    lines.push(bullet('Node', '`' + objective.id + '`'));
    lines.push(bullet('Title', objective.title));
    lines.push(bullet('Goal', objective.goal));
    lines.push(bullet('Scope', objective.scope));
  } else {
    lines.push('_Objective node missing (invalid graph)._');
  }
  lines.push('', '### Node contracts', '');
  for (const n of graph.nodes) {
    lines.push('#### `' + n.id + '` (' + n.kind + ') — ' + n.title, '');
    lines.push(bullet('Goal', n.goal));
    lines.push(bullet('Scope', n.scope));
    lines.push(
      bullet(
        'Inputs',
        n.contract.inputs.length > 0
          ? n.contract.inputs.map((s) => '`' + s + '`').join(', ')
          : '_(none)_',
      ),
    );
    lines.push(
      bullet(
        'Outputs',
        n.contract.outputs.length > 0
          ? n.contract.outputs.map((s) => '`' + s + '`').join(', ')
          : '_(none)_',
      ),
    );
    lines.push(bullet('Acceptance', ''));
    for (const a of n.contract.acceptance) {
      const hook = a.evidenceHook ? ' (hook `' + a.evidenceHook + '`)' : '';
      lines.push('  - `' + a.kind + '` ' + a.description + hook);
    }
    lines.push('');
  }
  lines.push('### Dependencies', '');
  if (graph.edges.length === 0) lines.push('_No dependency edges._');
  else {
    for (const e of graph.edges) {
      lines.push('- `' + e.from + '` → `' + e.to + '` (`' + e.kind + '`) ' + e.description);
    }
  }
  lines.push('', '### Resources', '');
  let resourceCount = 0;
  for (const n of graph.nodes) {
    for (const r of n.contract.resources) {
      resourceCount += 1;
      lines.push(
        '- node `' + n.id + '`: `' + r.kind + '` key=`' + r.key + '` exclusive=' + String(r.exclusive),
      );
    }
  }
  if (resourceCount === 0) lines.push('_No resource requirements declared._');
  lines.push('', '### Proof commands', '');
  if (proof.length === 0) lines.push('_No mechanical proof commands declared._');
  else {
    for (const c of proof) {
      const hook = c.evidenceHook ? ' · hook `' + c.evidenceHook + '`' : '';
      lines.push('- node `' + c.nodeId + '` (`' + c.kind + '`): `' + c.command + '`' + hook);
    }
  }
  lines.push('', '### Unknowns', '');
  if (packet.unknowns.length === 0) lines.push('_No open unknowns declared._');
  else {
    for (const u of packet.unknowns) {
      const src =
        u.source === 'investigation_node'
          ? 'investigation' + (u.nodeId ? ' `' + u.nodeId + '`' : '')
          : 'declared';
      lines.push('- (' + src + ') ' + u.text);
    }
  }
  lines.push('', '### Top-level integration check', '');
  lines.push(
    bullet('Requires top-level verification', '`' + String(graph.integration.requiresTopLevelVerification) + '`'),
  );
  lines.push(bullet('Objective node', '`' + graph.integration.objectiveNodeId + '`'));
  for (const a of graph.integration.acceptance) {
    const hook = a.evidenceHook ? ' (hook `' + a.evidenceHook + '`)' : '';
    lines.push('- `' + a.kind + '` ' + a.description + hook);
  }
  lines.push('', '### Operator decisions', '');
  lines.push(
    '_These require human judgement or stay outside agent authority. The packet does not approve them._',
    '',
  );
  for (const d of decisions) {
    const where = d.nodeId ? ' @`' + d.nodeId + '`' : '';
    lines.push('- `' + d.kind + '`' + where + ': ' + d.text);
  }
  lines.push('');
  if (packet.notes) {
    lines.push('### Notes (redacted)', '', packet.notes, '');
  }
  lines.push(
    '_End of advisory proposed graph. Child tasks are not created from this artifact._',
    '',
  );
  return lines.join('\n');
}

function issue(code: TaskGraphValidationIssue['code'], message: string): TaskGraphValidationIssue {
  return { code, message: redactProposedGraphText(message, MAX_PROPOSED_GRAPH_UNKNOWN_LEN) };
}

function isSha256Hex(v: string): boolean {
  return v.length === 64 && /^[0-9a-f]+$/.test(v);
}

function normalizeStoredUnknowns(raw: unknown[]): readonly ProposedGraphUnknown[] {
  const out: ProposedGraphUnknown[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    const u = item as Record<string, unknown>;
    if (u['source'] !== 'declared' && u['source'] !== 'investigation_node') continue;
    if (typeof u['text'] !== 'string') continue;
    const text = redactProposedGraphText(u['text'], MAX_PROPOSED_GRAPH_UNKNOWN_LEN);
    if (text.length === 0) continue;
    if (typeof u['nodeId'] === 'string' && u['nodeId'].length > 0) {
      out.push({ source: u['source'], text, nodeId: u['nodeId'] });
    } else {
      out.push({ source: u['source'], text });
    }
    if (out.length >= MAX_PROPOSED_GRAPH_UNKNOWNS) break;
  }
  return out;
}

export function parseProposedGraphPacket(text: string): ProposedGraphPacketParseResult {
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new ProposedGraphPacketError('proposed graph packet document must be a non-empty string');
  }
  if (text.length > MAX_PROPOSED_GRAPH_PACKET_BYTES) {
    throw new ProposedGraphPacketError('proposed graph packet document exceeds size bound');
  }
  if (
    !text.includes(PROPOSED_GRAPH_PACKET_HEADING) &&
    !text.includes(PROPOSED_GRAPH_PACKET_BLOCK_START)
  ) {
    throw new ProposedGraphPacketError('proposed graph packet not found');
  }
  let searchFrom = 0;
  let lastJson: string | null = null;
  while (searchFrom < text.length) {
    const s = text.indexOf(PROPOSED_GRAPH_PACKET_BLOCK_START, searchFrom);
    if (s < 0) break;
    const jsonStart = s + PROPOSED_GRAPH_PACKET_BLOCK_START.length;
    const after = text.slice(jsonStart);
    const nl = after.startsWith('\n') ? 1 : after.startsWith('\r\n') ? 2 : 0;
    const e = text.indexOf(PROPOSED_GRAPH_PACKET_BLOCK_END, jsonStart + nl);
    if (e < 0) break;
    lastJson = text.slice(jsonStart + nl, e).trim();
    searchFrom = e + PROPOSED_GRAPH_PACKET_BLOCK_END.length;
  }
  if (!lastJson) {
    return { ok: false, errors: [issue('schema', 'proposed graph JSON block missing')] };
  }
  let value: unknown;
  try {
    value = JSON.parse(lastJson) as unknown;
  } catch {
    return { ok: false, errors: [issue('schema', 'proposed graph JSON is not valid')] };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, errors: [issue('schema', 'proposed graph payload must be an object')] };
  }
  const o = value as Record<string, unknown>;
  if (o['version'] !== PROPOSED_GRAPH_PACKET_VERSION) {
    return { ok: false, errors: [issue('schema', 'proposed graph packet version mismatch')] };
  }
  if (o['kind'] !== 'proposed_graph' || o['mode'] !== 'advisory' || o['verifiedWork'] !== false) {
    return {
      ok: false,
      errors: [issue('schema', 'proposed graph packet must be advisory with verifiedWork=false')],
    };
  }
  if (typeof o['packetDigest'] !== 'string' || !isSha256Hex(o['packetDigest'])) {
    return { ok: false, errors: [issue('schema', 'packetDigest missing or invalid')] };
  }
  if (typeof o['graphDigest'] !== 'string' || !isSha256Hex(o['graphDigest'])) {
    return { ok: false, errors: [issue('schema', 'graphDigest missing or invalid')] };
  }
  let graph: TaskGraph;
  try {
    graph = parseTaskGraph(JSON.stringify(o['graph']));
  } catch (err) {
    if (err instanceof TaskGraphValidationError) {
      return {
        ok: false,
        errors: err.issues.length > 0 ? err.issues : [issue('schema', err.message)],
      };
    }
    return { ok: false, errors: [issue('schema', 'embedded graph failed validation')] };
  }
  if (taskGraphDigest(graph) !== o['graphDigest']) {
    return { ok: false, errors: [issue('schema', 'graphDigest does not match embedded graph')] };
  }
  const unknowns = Array.isArray(o['unknowns'])
    ? normalizeStoredUnknowns(o['unknowns'])
    : mergeUnknowns([], extractInvestigationUnknowns(graph));
  let notes: string | null = null;
  if (typeof o['notes'] === 'string' && o['notes'].trim().length > 0) {
    notes = redactProposedGraphText(o['notes'], MAX_PROPOSED_GRAPH_NOTES_LEN);
  }
  const base = {
    version: PROPOSED_GRAPH_PACKET_VERSION,
    kind: 'proposed_graph' as const,
    mode: 'advisory' as const,
    verifiedWork: false as const,
    graph,
    graphDigest: o['graphDigest'] as string,
    unknowns,
    notes,
  };
  const expectedDigest = proposedGraphPacketDigest(base);
  if (expectedDigest !== o['packetDigest']) {
    return { ok: false, errors: [issue('schema', 'packetDigest mismatch')] };
  }
  return { ok: true, packet: { ...base, packetDigest: expectedDigest } };
}
