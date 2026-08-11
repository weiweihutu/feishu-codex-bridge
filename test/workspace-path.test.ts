import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const sourceFiles = [
  '../src/core/audit-trace.ts',
  '../src/bot/media.ts',
];

describe('workspace persistence paths', () => {
  it.each(sourceFiles)('%s uses workspace instead of my_workspace', (relativePath) => {
    const sourcePath = fileURLToPath(new URL(relativePath, import.meta.url));
    const source = readFileSync(sourcePath, 'utf8');

    expect(source).toContain("join(paths.appDir, 'workspace')");
    expect(source).not.toContain("join(paths.appDir, 'my_workspace')");
  });
});
