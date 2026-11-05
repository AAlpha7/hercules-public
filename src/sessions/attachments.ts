/**
 * Session attachment storage — files under
 *   `<workRoot>/rc-sessions/<sessionId>/files/<safeName>`
 * Also copied into the agent worktree at `.scratch/uploads/` when a cwd is known.
 */
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, basename } from 'node:path';
import {
  isValidSessionId,
  SESSION_ATTACHMENT_MAX_BYTES,
  SESSION_IMAGE_MIMES,
  type AttachmentKind,
  type ChatAttachment,
} from '../domain/session.js';
import { newMessageId } from '../domain/session.js';

export class AttachmentError extends Error {
  override readonly name = 'AttachmentError';
}

function safeFileName(name: string): string {
  const base = basename(name).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
  return base.length > 0 ? base : 'file';
}

export function attachmentsDir(workRoot: string, sessionId: string): string {
  if (!isValidSessionId(sessionId)) {
    throw new AttachmentError(`unsafe session id '${sessionId}'`);
  }
  return join(workRoot, 'rc-sessions', sessionId, 'files');
}

export async function saveSessionAttachment(input: {
  readonly workRoot: string;
  readonly sessionId: string;
  readonly name: string;
  readonly mime: string;
  readonly data: Buffer;
  /** Optional worktree cwd — copy into .scratch/uploads for agent tools. */
  readonly workspaceDir?: string | null;
}): Promise<ChatAttachment> {
  if (input.data.byteLength === 0) throw new AttachmentError('empty attachment');
  if (input.data.byteLength > SESSION_ATTACHMENT_MAX_BYTES) {
    throw new AttachmentError(
      `attachment too large (max ${SESSION_ATTACHMENT_MAX_BYTES} bytes)`,
    );
  }
  const mime = (input.mime || 'application/octet-stream').toLowerCase();
  const kind: AttachmentKind = SESSION_IMAGE_MIMES.has(mime) ? 'image' : 'file';
  const id = newMessageId();
  const safe = safeFileName(input.name);
  const fileName = `${id}-${safe}`;
  const dir = attachmentsDir(input.workRoot, input.sessionId);
  await mkdir(dir, { recursive: true });
  const abs = join(dir, fileName);
  await writeFile(abs, input.data);

  // Agent-visible path (relative-style for prompts).
  const relPath = `.scratch/uploads/${fileName}`;
  if (input.workspaceDir) {
    const uploadDir = join(input.workspaceDir, '.scratch', 'uploads');
    await mkdir(uploadDir, { recursive: true });
    await writeFile(join(uploadDir, fileName), input.data);
  }

  return {
    id,
    kind,
    name: input.name.slice(0, 120) || safe,
    relPath,
    mime,
    bytes: input.data.byteLength,
  };
}

export async function readSessionAttachmentFile(
  workRoot: string,
  sessionId: string,
  fileName: string,
): Promise<Buffer> {
  const safe = basename(fileName);
  if (safe !== fileName || safe.includes('..')) {
    throw new AttachmentError('unsafe attachment path');
  }
  return readFile(join(attachmentsDir(workRoot, sessionId), safe));
}

export async function removeSessionAttachments(
  workRoot: string,
  sessionId: string,
): Promise<void> {
  try {
    await rm(join(workRoot, 'rc-sessions', sessionId), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
