import { describe, it, expect } from "vitest";
import { parseDiffLines } from "../.sandcastle/review/parse-diff-lines.js";

const simpleDiff = `diff --git a/app/foo.ts b/app/foo.ts
index abc1234..def5678 100644
--- a/app/foo.ts
+++ b/app/foo.ts
@@ -10,6 +10,8 @@ some context
 context line 10
 context line 11
+added line 12
+added line 13
 context line 14
 context line 15
 context line 16
 context line 17
`;

const multiFileDiff = `diff --git a/app/alpha.ts b/app/alpha.ts
index 1111111..2222222 100644
--- a/app/alpha.ts
+++ b/app/alpha.ts
@@ -1,3 +1,4 @@
 line 1
+inserted line 2
 line 3
 line 4
diff --git a/app/beta.ts b/app/beta.ts
index 3333333..4444444 100644
--- a/app/beta.ts
+++ b/app/beta.ts
@@ -5,4 +5,3 @@ header
 context 5
-removed 6
 context 6
 context 7
`;

const deletionOnlyDiff = `diff --git a/app/del.ts b/app/del.ts
index aaa..bbb 100644
--- a/app/del.ts
+++ b/app/del.ts
@@ -1,4 +1,3 @@
 keep 1
-remove 2
 keep 2
 keep 3
`;

const multiHunkDiff = `diff --git a/app/multi.ts b/app/multi.ts
index aaa..bbb 100644
--- a/app/multi.ts
+++ b/app/multi.ts
@@ -2,3 +2,4 @@ header
 ctx 2
+add 3
 ctx 4
@@ -20,3 +21,4 @@ header2
 ctx 21
+add 22
 ctx 23
`;

const newFileDiff = `diff --git a/app/new.ts b/app/new.ts
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/app/new.ts
@@ -0,0 +1,3 @@
+line 1
+line 2
+line 3
`;

const noNewlineDiff = `diff --git a/app/trail.ts b/app/trail.ts
index abc..def 100644
--- a/app/trail.ts
+++ b/app/trail.ts
@@ -1,3 +1,3 @@
 line 1
-old line 2
+new line 2
 line 3
\\ No newline at end of file
`;

const modeOnlyDiff = `diff --git a/app/script.sh b/app/script.sh
old mode 100644
new mode 100755
`;

const renamedFileDiff = `diff --git a/app/old-name.ts b/app/new-name.ts
similarity index 80%
rename from app/old-name.ts
rename to app/new-name.ts
index abc..def 100644
--- a/app/old-name.ts
+++ b/app/new-name.ts
@@ -1,3 +1,4 @@
 line 1
+added line 2
 line 3
 line 4
`;

const binaryFileDiff = `diff --git a/assets/logo.png b/assets/logo.png
new file mode 100644
index 0000000..abc1234
Binary files /dev/null and b/assets/logo.png differ
`;

const contentStartingWithPlusDiff = `diff --git a/app/plus.ts b/app/plus.ts
index abc..def 100644
--- a/app/plus.ts
+++ b/app/plus.ts
@@ -1,2 +1,3 @@
 line 1
+++ added content starting with double plus
 line 2
`;

describe("parseDiffLines", () => {
  it("returns valid right-side line numbers from a simple diff", () => {
    const result = parseDiffLines(simpleDiff);
    const fooLines = result.get("app/foo.ts");
    expect(fooLines).toBeDefined();
    // context lines 10, 11 + added 12, 13 + context 14, 15, 16, 17
    expect(fooLines).toEqual(new Set([10, 11, 12, 13, 14, 15, 16, 17]));
  });

  it("handles multiple files", () => {
    const result = parseDiffLines(multiFileDiff);
    expect(result.get("app/alpha.ts")).toEqual(new Set([1, 2, 3, 4]));
    // beta: context 5, context 6 (was 7), context 7 (was 8). Removed line doesn't appear.
    expect(result.get("app/beta.ts")).toEqual(new Set([5, 6, 7]));
  });

  it("handles deletion-only hunks (only context lines on right side)", () => {
    const result = parseDiffLines(deletionOnlyDiff);
    expect(result.get("app/del.ts")).toEqual(new Set([1, 2, 3]));
  });

  it("handles multiple hunks in one file", () => {
    const result = parseDiffLines(multiHunkDiff);
    const lines = result.get("app/multi.ts");
    expect(lines).toEqual(new Set([2, 3, 4, 21, 22, 23]));
  });

  it("returns empty map for empty diff", () => {
    expect(parseDiffLines("")).toEqual(new Map());
  });

  it("returns empty map for whitespace-only diff", () => {
    expect(parseDiffLines("   \n\n  ")).toEqual(new Map());
  });

  it("handles new file diffs", () => {
    const result = parseDiffLines(newFileDiff);
    expect(result.get("app/new.ts")).toEqual(new Set([1, 2, 3]));
  });

  it("skips the no-newline-at-end-of-file marker without breaking line counts", () => {
    const result = parseDiffLines(noNewlineDiff);
    expect(result.get("app/trail.ts")).toEqual(new Set([1, 2, 3]));
  });

  it("handles mode-only changes with no hunks", () => {
    const result = parseDiffLines(modeOnlyDiff);
    expect(result.get("app/script.sh")).toEqual(new Set());
  });

  it("handles renamed files using the new path", () => {
    const result = parseDiffLines(renamedFileDiff);
    expect(result.has("app/old-name.ts")).toBe(false);
    expect(result.get("app/new-name.ts")).toEqual(new Set([1, 2, 3, 4]));
  });

  it("handles binary files with no line content", () => {
    const result = parseDiffLines(binaryFileDiff);
    expect(result.get("assets/logo.png")).toEqual(new Set());
  });

  it("handles added lines whose content starts with ++", () => {
    const result = parseDiffLines(contentStartingWithPlusDiff);
    expect(result.get("app/plus.ts")).toEqual(new Set([1, 2, 3]));
  });
});
