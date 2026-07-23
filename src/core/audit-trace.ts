import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { paths } from '../config/paths';
import { currentLogContext, log, type LogFields } from './logger';

const DEFAULT_TEXT_LIMIT = 20_000;

export interface TraceIo {
  workspaceRoot?: string;
  now?: () => Date;
}

export interface AuditMessage {
  messageId: string;
  chatId: string;
  threadId?: string | null;
  senderId?: string | null;
  chatType: string;
  mentionedBot: boolean;
  createTime?: number;
}

export type AuditFields = Record<string, unknown>;

function workspaceRoot(io: TraceIo): string {
  return io.workspaceRoot ?? join(paths.appDir, 'my_workspace');
}

function currentTime(io: TraceIo): Date {
  return io.now?.() ?? new Date();
}

function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10).replaceAll('-', '');
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 160) || '_';
}

export function truncateAuditText(
  value: unknown,
  limit = DEFAULT_TEXT_LIMIT,
): { text: string; truncated: boolean } {
  const text = String(value ?? '');
  return text.length > limit
    ? { text: text.slice(0, limit), truncated: true }
    : { text, truncated: false };
}

export function buildAuditContext(
  msg: AuditMessage,
  text: unknown,
  extras: AuditFields = {},
  limit = DEFAULT_TEXT_LIMIT,
): AuditFields {
  const messageText = truncateAuditText(text, limit);
  return {
    msgId: msg.messageId,
    chatId: msg.chatId,
    threadId: msg.threadId ?? null,
    senderId: msg.senderId ?? null,
    chatType: msg.chatType,
    mentionedBot: msg.mentionedBot,
    messageText: messageText.text,
    messageTextTruncated: messageText.truncated,
    receivedAt: new Date(msg.createTime || Date.now()).toISOString(),
    ...extras,
  };
}

export function emitTraceStep(step: AuditFields = {}, io: TraceIo = {}): void {
  try {
    const now = currentTime(io);
    const root = workspaceRoot(io);
    const dir = join(root, 'traces', 'logs');
    const entry: AuditFields = {
      ts: now.toISOString(),
      event: 'trace_step',
      status: 'success',
      ...step,
    };
    if ('input_text' in entry) {
      entry.input_text = truncateAuditText(entry.input_text).text;
    }
    if ('output_text' in entry) {
      entry.output_text = truncateAuditText(entry.output_text).text;
    }
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      join(dir, `trace-${dateKey(now)}.log`),
      `${JSON.stringify(entry)}\n`,
      'utf8',
    );
  } catch {
    // Trace persistence must never affect message handling.
  }
}

export function traceArtifactPath(
  msgId: string,
  name: string,
  content: unknown,
  kind: 'text' | 'json' = 'text',
  io: TraceIo = {},
): string | null {
  try {
    const now = currentTime(io);
    const root = workspaceRoot(io);
    const dir = join(
      root,
      'traces',
      'artifacts',
      dateKey(now),
      safeName(msgId),
    );
    const file = join(dir, safeName(name));
    const body =
      kind === 'json' ? JSON.stringify(content, null, 2) : String(content ?? '');
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, body, 'utf8');
    return relative(root, file);
  } catch {
    return null;
  }
}

export function emitMessageCompletedAudit(
  audit: AuditFields,
  fields: AuditFields = {},
  io: TraceIo = {},
): void {
  const reply = truncateAuditText(fields.replyText);
  const payload: AuditFields = {
    ...audit,
    ...fields,
    replyText: reply.text,
    replyTextTruncated: reply.truncated,
    ...currentLogContext(),
  };

  log.info('audit', 'message_completed', payload as LogFields);

  try {
    emitTraceStep(
      {
        event: 'codex.response_composed',
        msgId: payload.msgId,
        chatId: payload.chatId,
        threadId: payload.threadId ?? null,
        project: payload.project,
        traceId: payload.traceId,
        receivedAt: payload.receivedAt,
        elapsedMs: payload.elapsedMs,
        model: payload.model,
        replyText: payload.replyText,
        terminal: payload.terminal,
        textChars: payload.textChars,
        images: payload.images,
        imageFiles: payload.imageFiles,
      },
      io,
    );
  } catch {
    // Audit logging remains useful even when trace persistence fails.
  }
}
