/**
 * Zero-dependency stdio MCP server: hercules_workspace apply_patch + delete_file.
 *
 * Protocol: JSON-RPC 2.0 over stdio with Content-Length framing (MCP standard).
 * Also accepts NDJSON (one JSON object per line) for focused tests.
 *
 * Workspace root: HERCULES_WORKSPACE env, or --workspace <path>.
 *
 * Tool names (server-local): apply_patch, delete_file.
 * Grok namespaces them as hercules_workspace__apply_patch / __delete_file.
 */
import {
  applyWorkspacePatch,
  deleteWorkspaceFile,
  WorkspaceToolError,
} from './workspaceTools.js';

const SERVER_NAME = 'hercules_workspace';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2024-11-05';

interface JsonRpcRequest {
  readonly jsonrpc?: string;
  readonly id?: string | number | null;
  readonly method?: string;
  readonly params?: unknown;
}

interface ToolContent {
  readonly type: 'text';
  readonly text: string;
}

function toolResult(text: string, isError = false): {
  content: ToolContent[];
  isError: boolean;
} {
  return {
    content: [{ type: 'text', text }],
    isError,
  };
}

function resolveWorkspace(argv: readonly string[], env: NodeJS.ProcessEnv): string {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--workspace' && argv[i + 1]) {
      return argv[i + 1]!;
    }
    if (argv[i]?.startsWith('--workspace=')) {
      return argv[i]!.slice('--workspace='.length);
    }
  }
  const fromEnv = env['HERCULES_WORKSPACE']?.trim();
  if (fromEnv) return fromEnv;
  throw new Error('HERCULES_WORKSPACE env or --workspace <path> is required');
}

const TOOLS = [
  {
    name: 'apply_patch',
    description:
      'Apply a unified git diff inside the allocated workspace (check-first, no shell).',
    inputSchema: {
      type: 'object',
      properties: {
        patch: {
          type: 'string',
          description: 'Unified diff (git apply format)',
        },
      },
      required: ['patch'],
    },
  },
  {
    name: 'delete_file',
    description:
      'Delete a workspace-relative file or symlink. Rejects absolute/traversal/directory targets.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Workspace-relative path to delete',
        },
      },
      required: ['path'],
    },
  },
] as const;

async function callTool(
  workspaceRoot: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: ToolContent[]; isError: boolean }> {
  try {
    if (name === 'apply_patch') {
      const result = await applyWorkspacePatch({ workspaceRoot }, args['patch']);
      return toolResult(JSON.stringify(result));
    }
    if (name === 'delete_file') {
      const result = await deleteWorkspaceFile({ workspaceRoot }, args['path']);
      return toolResult(JSON.stringify(result));
    }
    return toolResult(`unknown tool: ${name}`, true);
  } catch (err) {
    if (err instanceof WorkspaceToolError) {
      return toolResult(JSON.stringify({ error: err.message, code: err.code }), true);
    }
    const msg = err instanceof Error ? err.message : String(err);
    return toolResult(JSON.stringify({ error: msg, code: 'internal' }), true);
  }
}

function encodeContentLength(body: string): string {
  const buf = Buffer.from(body, 'utf8');
  return `Content-Length: ${buf.length}\r\n\r\n${body}`;
}

function writeMessage(
  out: NodeJS.WritableStream,
  msg: unknown,
  mode: 'content-length' | 'ndjson',
): void {
  const body = JSON.stringify(msg);
  if (mode === 'ndjson') {
    out.write(body + '\n');
  } else {
    out.write(encodeContentLength(body));
  }
}

async function handleRequest(
  workspaceRoot: string,
  req: JsonRpcRequest,
): Promise<unknown | null> {
  const method = typeof req.method === 'string' ? req.method : '';
  const id = req.id;

  // Notifications have no response.
  if (method === 'notifications/initialized' || method === 'initialized') {
    return null;
  }

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id: id ?? null,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      },
    };
  }

  if (method === 'ping') {
    return { jsonrpc: '2.0', id: id ?? null, result: {} };
  }

  if (method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id: id ?? null,
      result: { tools: TOOLS },
    };
  }

  if (method === 'tools/call') {
    const params = (req.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
    const name = typeof params.name === 'string' ? params.name : '';
    const args =
      params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
    const result = await callTool(workspaceRoot, name, args);
    return { jsonrpc: '2.0', id: id ?? null, result };
  }

  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: { code: -32601, message: `Method not found: ${method}` },
  };
}

/**
 * Run the MCP server on the given streams. Resolves when stdin ends.
 * Exported for tests.
 */
export async function runWorkspaceMcpServer(opts: {
  readonly workspaceRoot: string;
  readonly stdin?: NodeJS.ReadableStream;
  readonly stdout?: NodeJS.WritableStream;
}): Promise<void> {
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  let mode: 'content-length' | 'ndjson' | null = null;
  let buffer = '';
  let chain: Promise<void> = Promise.resolve();

  const processMessage = async (raw: string): Promise<void> => {
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(raw) as JsonRpcRequest;
    } catch {
      return;
    }
    const response = await handleRequest(opts.workspaceRoot, req);
    if (response !== null) {
      writeMessage(stdout, response, mode ?? 'ndjson');
    }
  };

  const drainOnce = async (): Promise<void> => {
    for (;;) {
      if (mode === null) {
        const trimmedStart = buffer.trimStart();
        if (trimmedStart.startsWith('Content-Length:') || trimmedStart.startsWith('content-length:')) {
          mode = 'content-length';
        } else if (buffer.includes('\n')) {
          mode = 'ndjson';
        } else if (buffer.length > 64 * 1024) {
          mode = 'ndjson';
        } else {
          return;
        }
      }

      if (mode === 'content-length') {
        const headerEnd = buffer.indexOf('\r\n\r\n');
        const altEnd = headerEnd < 0 ? buffer.indexOf('\n\n') : -1;
        const end = headerEnd >= 0 ? headerEnd : altEnd;
        const sepLen = headerEnd >= 0 ? 4 : 2;
        if (end < 0) return;
        const header = buffer.slice(0, end);
        const match = /Content-Length:\s*(\d+)/i.exec(header);
        if (!match) {
          buffer = buffer.slice(end + sepLen);
          continue;
        }
        const len = Number(match[1]);
        const bodyStart = end + sepLen;
        if (buffer.length < bodyStart + len) return;
        const body = buffer.slice(bodyStart, bodyStart + len);
        buffer = buffer.slice(bodyStart + len);
        await processMessage(body);
        continue;
      }

      // NDJSON
      const nl = buffer.indexOf('\n');
      if (nl < 0) return;
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line.length > 0) await processMessage(line);
    }
  };

  const enqueueDrain = (): void => {
    chain = chain.then(drainOnce);
  };

  await new Promise<void>((resolve, reject) => {
    stdin.on('data', (chunk: Buffer | string) => {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      enqueueDrain();
    });
    stdin.on('error', reject);
    stdin.on('end', () => {
      enqueueDrain();
      void chain
        .then(async () => {
          if (buffer.trim().length > 0) {
            if (mode === null) mode = 'ndjson';
            await processMessage(buffer.trim());
            buffer = '';
          }
          resolve();
        })
        .catch(reject);
    });
  });
}

/** CLI entry when executed as `node …/workspaceServer.js`. */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const workspaceRoot = resolveWorkspace(argv, env);
  await runWorkspaceMcpServer({ workspaceRoot });
}

const isDirect =
  typeof process.argv[1] === 'string' &&
  (process.argv[1].endsWith('workspaceServer.js') ||
    process.argv[1].endsWith('workspaceServer.ts'));

if (isDirect) {
  main().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[hercules_workspace] ${msg}\n`);
    process.exit(1);
  });
}
