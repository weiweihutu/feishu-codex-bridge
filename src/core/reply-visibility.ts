export interface ReplyMetadata {
  source?: string;
  system?: string;
  knowledgeBases?: string;
  note?: string;
}

export interface ReplyPresentation {
  fullText: string;
  visibleText: string;
  metadata: ReplyMetadata;
}

export type ReplyVisibilityMode = 'streaming' | 'terminal';

type MetadataKey = keyof ReplyMetadata;

const LABELS: Record<string, MetadataKey> = {
  来源: 'source',
  系统: 'system',
  知识库: 'knowledgeBases',
  说明: 'note',
};

const LABEL_PATTERN = /^(来源|系统|知识库|说明)\s*[:：]\s*(.*)$/;
const SOURCE_PATTERN = /^\s*来源\s*[:：]/;

function appendMetadata(metadata: ReplyMetadata, key: MetadataKey, value: string): void {
  const previous = metadata[key];
  metadata[key] = previous ? `${previous}\n${value}` : value;
}

function terminalPresentation(fullText: string): ReplyPresentation {
  const lines = fullText.split('\n');

  for (let start = lines.length - 1; start >= 0; start--) {
    if (!SOURCE_PATTERN.test(lines[start] ?? '')) continue;

    const metadata: ReplyMetadata = {};
    let currentKey: MetadataKey | undefined;
    let recognized = 0;
    let valid = true;

    for (const rawLine of lines.slice(start)) {
      const line = rawLine.trim();
      if (!line) continue;

      const match = line.match(LABEL_PATTERN);
      if (match) {
        currentKey = LABELS[match[1]!]!;
        appendMetadata(metadata, currentKey, match[2]!.trim());
        recognized++;
      } else if (currentKey) {
        appendMetadata(metadata, currentKey, line);
      } else {
        valid = false;
        break;
      }
    }

    const visibleText = lines.slice(0, start).join('\n').trim();
    if (valid && recognized >= 2 && metadata.source !== undefined && visibleText) {
      return { fullText, visibleText, metadata };
    }
  }

  return { fullText, visibleText: fullText, metadata: {} };
}

export function parseReplyPresentation(value: string): ReplyPresentation {
  const fullText = String(value ?? '').replace(/\r\n?/g, '\n').trim();
  if (!fullText) return { fullText: '', visibleText: '', metadata: {} };
  return terminalPresentation(fullText);
}

export function visibleReplyText(value: string, mode: ReplyVisibilityMode = 'terminal'): string {
  const fullText = String(value ?? '').replace(/\r\n?/g, '\n').trim();
  if (!fullText) return '';

  if (mode === 'streaming') {
    const lines = fullText.split('\n');
    const start = lines.findIndex((line) => SOURCE_PATTERN.test(line));
    if (start >= 0) {
      const visibleText = lines.slice(0, start).join('\n').trim();
      if (visibleText) return visibleText;
    }
  }

  return terminalPresentation(fullText).visibleText;
}
