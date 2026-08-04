# Reply Visibility Source Integration Design

## Goal

Make the source-managed `feishu-codex-bridge` show only user-facing reply
content in Feishu cards while retaining the complete model reply and provenance
metadata for audit and downstream quality analysis.

This replaces the runtime patch that edits the installed `dist/cli.js`.

## Reply Contract

The model may append a terminal metadata block to its final answer:

```text
来源：知识库
系统：OMS
知识库：oms-business-wiki
说明：本次未做实时系统查询。
```

The bridge treats the answer as three representations:

- `replyText`: the complete model reply, unchanged.
- `visibleReplyText`: the content shown to the Feishu user.
- `replyMetadata`: structured values parsed from the terminal metadata block.

Normal prose containing words such as `来源` or `订单来源字段` must remain
visible.

## Architecture

Add a pure module at `src/core/reply-visibility.ts`.

It exports:

```ts
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

export function parseReplyPresentation(text: string): ReplyPresentation;
export function visibleReplyText(text: string, mode?: 'streaming' | 'terminal'): string;
```

The module has no Feishu, card, logging, or filesystem dependencies.

## Parsing Rules

Terminal parsing searches backward for a standalone line beginning with
`来源：` or `来源:`. The candidate suffix is metadata only when:

1. it starts with `来源`;
2. every non-empty line belongs to `来源`, `系统`, `知识库`, or `说明`, including
   continuation lines belonging to the preceding field;
3. at least two recognized labels are present;
4. non-empty visible content remains before the suffix.

If these conditions are not met, the complete text remains visible and
metadata is empty.

Line endings are normalized for parsing. The returned full text otherwise
preserves the complete trimmed reply.

For streaming cards, an exact standalone `来源：` line marks the beginning of
the hidden suffix immediately. This prevents provenance from briefly appearing
while the remaining metadata lines are still streaming. Terminal rendering and
audit extraction use the stricter complete-block validation.

## Card Integration

`src/card/run-card.ts` remains the only presentation boundary.

`renderRunning` passes the concatenated text blocks through:

```ts
visibleReplyText(answer, 'streaming')
```

`renderTerminal` passes the final answer block through:

```ts
visibleReplyText(answer, 'terminal')
```

No text is removed from `RunState`. Reasoning, tool blocks, images, review
controls, and card streaming behavior remain unchanged.

## Audit Integration

`emitOrdinaryTurnCompletion` continues to derive the complete answer from
`finalMessageText`.

For successful ordinary turns it parses that answer once and emits:

```ts
{
  replyText: presentation.fullText,
  visibleReplyText: presentation.visibleText,
  replyMetadata: presentation.metadata,
  textChars: presentation.fullText.length
}
```

`replyText` remains the authoritative internal record. Existing consumers that
only read `replyText` continue to work. The audit collector can consume
`visibleReplyText` directly and retain its existing derivation fallback for
historical events.

Error completions keep empty reply fields and do not manufacture metadata.

## Deployment

The feature is compiled into the maintained fork:

```text
TypeScript source -> npm run build -> dist/cli.js -> installed bridge
```

After deployment, `workspace/gbrain/run_feishu_bot.sh` starts the configured
bridge directly. It no longer invokes
`patch_feishu_bridge_reply_visibility.py`.

The patch script and its dedicated tests are deleted only after the fork has
been built, installed, and verified on the target environment.

## Testing

Add focused unit coverage for:

- valid terminal metadata extraction;
- ASCII and Chinese colons;
- multiline `说明`;
- ordinary uses of the word `来源`;
- a lone or malformed `来源` suffix;
- streaming suppression beginning at the standalone source line;
- running and terminal cards excluding metadata;
- completion audit retaining `replyText`;
- completion audit emitting `visibleReplyText` and structured metadata.

Run:

```bash
npm test -- --run test/reply-visibility.test.ts test/run-render.test.ts test/queued-card.test.ts
npm run typecheck
npm run build
```

## Non-Goals

- Changing the model prompt or requiring JSON output.
- Removing provenance from stored audit data.
- Changing replies outside the ordinary Feishu run-card flow.
- Adding a user-facing switch for metadata visibility.
