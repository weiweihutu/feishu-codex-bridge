import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { AgentEvent } from '../agent/types';
import { paths } from '../config/paths';
import {
  currentLogContext,
  log,
  withTrace,
  type LogContext,
  type LogFields,
} from './logger';

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
  content?: string;
}

export type AuditFields = Record<string, unknown>;
export type AuditContext = Record<string, unknown> & {
  msgId: string;
  chatId: string;
  threadId: string | null;
  senderId: string | null;
};

const AUDIT_CORE_KEYS = new Set([
  'msgId',
  'chatId',
  'threadId',
  'senderId',
  'chatType',
  'mentionedBot',
  'messageText',
  'messageTextTruncated',
  'receivedAt',
]);

function nonEmptyString(...values: unknown[]): string | undefined {
  return values.find(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
}

function normalizeCorrelationIds(
  audit: AuditContext | undefined,
  context: Readonly<LogFields>,
  fields: AuditFields,
): Pick<LogContext, 'traceId' | 'chatId' | 'msgId'> {
  return {
    traceId: nonEmptyString(fields.traceId, context.traceId, audit?.traceId),
    chatId: nonEmptyString(fields.chatId, context.chatId, audit?.chatId),
    msgId: nonEmptyString(fields.msgId, context.msgId, audit?.msgId),
  };
}

function workspaceRoot(io: TraceIo): string {
  return io.workspaceRoot ?? join(paths.appDir, 'my_workspace');
}

function currentTime(io: TraceIo): Date {
  return io.now?.() ?? new Date();
}

function dateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

function safeName(value: unknown, fallback: string): string {
  const safe = String(value || fallback).replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 160);
  return safe === '.' || safe === '..' ? fallback : safe;
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
): AuditContext {
  const messageText = truncateAuditText(text ?? msg.content ?? '', limit);
  const safeExtras = Object.fromEntries(
    Object.entries(extras).filter(([key]) => !AUDIT_CORE_KEYS.has(key)),
  );
  return {
    ...safeExtras,
    msgId: msg.messageId,
    chatId: msg.chatId,
    threadId: msg.threadId ?? null,
    senderId: msg.senderId ?? null,
    chatType: msg.chatType,
    mentionedBot: msg.mentionedBot,
    messageText: messageText.text,
    messageTextTruncated: messageText.truncated,
    receivedAt: new Date(msg.createTime || Date.now()).toISOString(),
  };
}

export function traceFieldsForAgentEvent(
  event: AgentEvent,
): AuditFields | null {
  if (event.type !== 'tool_use' && event.type !== 'tool_result') return null;
  const isGbrainMcp = event.toolType === 'mcp' && event.server === 'gbrain';
  const suffix = event.type === 'tool_use' ? 'started' : 'completed';
  return {
    step_name: isGbrainMcp ? `gbrain.mcp_${suffix}` : `tool.${suffix}`,
    step_type: event.toolType ?? 'tool',
    item_id: event.itemId,
    tool_server: event.server,
    tool_name: event.tool,
    request_json: event.toolInput,
    output_text: event.type === 'tool_result' ? event.output : undefined,
    status: event.error ? 'error' : event.status ?? 'success',
    error: event.error,
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
  msgId: unknown,
  name: unknown,
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
      safeName(msgId, 'unknown-message'),
    );
    const file = join(dir, safeName(name, 'artifact'));
    const body =
      kind === 'json' ? JSON.stringify(content ?? null, null, 2) : String(content ?? '');
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, body, 'utf8');
    return relative(root, file);
  } catch {
    return null;
  }
}

export function emitMessageCompletedAudit(
  audit: AuditContext | undefined,
  fields: AuditFields = {},
  io: TraceIo = {},
): void {
  const context = currentLogContext();
  const correlationIds = normalizeCorrelationIds(audit, context, fields);
  const merged: AuditFields = {
    ...(audit ?? {}),
    ...context,
    ...fields,
    ...correlationIds,
  };
  const reply = truncateAuditText(merged.replyText);
  const payload: AuditFields = {
    ...merged,
    replyText: reply.text,
    replyTextTruncated: reply.truncated,
  };

  withTrace(correlationIds, () => {
    payload.traceId = currentLogContext().traceId;
    log.info('audit', 'message_completed', payload as LogFields);
  });

  try {
    emitTraceStep(
      {
        msg_id: payload.msgId,
        trace_id: payload.traceId,
        chat_id: payload.chatId,
        thread_id: payload.threadId ?? null,
        project: payload.project,
        step_name: 'codex.response_composed',
        step_type: 'compose',
        started_at: payload.startedAt ?? payload.receivedAt,
        completed_at: payload.completedAt ?? currentTime(io).toISOString(),
        elapsed_ms: payload.elapsedMs,
        model: payload.model,
        output_text: payload.replyText,
        response_json: {
          terminal: payload.terminal,
          textChars: payload.textChars,
          images: payload.images,
          imageFiles: payload.imageFiles ?? [],
        },
      },
      io,
    );
  } catch {
    // Audit logging remains useful even when trace persistence fails.
  }
}
