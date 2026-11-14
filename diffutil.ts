// diffutil.ts — pure diff helpers: flat-tree comparison and line-count diffs.
// No store access here; the caller flattens trees first (store.ts) and passes bytes.

export interface FlatEntry {
  mode: string;
  oid: string;
}

export type FlatTree = Map<string, FlatEntry>;

export interface FileChange {
  path: string;
  status: 'added' | 'removed' | 'modified';
  oldOid: string | null;
  newOid: string | null;
}

/** Compare two flat trees (path -> entry): every added, removed or modified path. */
export function diffTrees(base: FlatTree, head: FlatTree): FileChange[] {
  const changes: FileChange[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of paths) {
    const before = base.get(path);
    const after = head.get(path);
    if (before === undefined && after !== undefined) {
      changes.push({ path, status: 'added', oldOid: null, newOid: after.oid });
    } else if (before !== undefined && after === undefined) {
      changes.push({ path, status: 'removed', oldOid: before.oid, newOid: null });
    } else if (before !== undefined && after !== undefined && before.oid !== after.oid) {
      changes.push({ path, status: 'modified', oldOid: before.oid, newOid: after.oid });
    }
  }
  changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return changes;
}

/** Split text into lines the way git counts them: a trailing newline ends the last line. */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** The LCS length of two line lists (two-row DP; only the length is needed). */
export function lcsLength(a: readonly string[], b: readonly string[]): number {
  // Keep the shorter list on the inner axis.
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  let prev = new Array<number>(short.length + 1).fill(0);
  let curr = new Array<number>(short.length + 1).fill(0);
  for (let i = 1; i <= long.length; i += 1) {
    curr[0] = 0;
    for (let j = 1; j <= short.length; j += 1) {
      curr[j] = long[i - 1] === short[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[short.length];
}

/** Line additions/deletions between two texts: new-lines minus LCS, old-lines minus LCS. */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const lcs = lcsLength(oldLines, newLines);
  return { additions: newLines.length - lcs, deletions: oldLines.length - lcs };
}
