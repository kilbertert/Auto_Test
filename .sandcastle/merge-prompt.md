# TASK

Merge the following branches into the current delivery branch
`{{DELIVERY_BRANCH}}`:

{{BRANCHES}}

First configure the merge commit identity:

```bash
git config user.name "claude-code[bot]"
git config user.email "claude-code[bot]@users.noreply.github.com"
```

For each branch:

1. Run `git merge <branch> --no-ff -m "chore(afk): merge <branch>"`
2. If there are merge conflicts, resolve them intelligently by reading both
   sides and choosing the correct resolution
3. After resolving conflicts, run `npm run check` to verify everything works
4. If tests fail, fix the issues before proceeding to the next branch

After all branches are merged, confirm the worktree is clean and the current
branch is still `{{DELIVERY_BRANCH}}`.

# DELIVERY BOUNDARY

Do not push, open or merge a PR, close issues, or modify labels. The host
wrapper will push `{{DELIVERY_BRANCH}}` and open one PR after you finish. The
hosting service closes the referenced issues only when that PR is merged.

Once you have merged and verified everything, output
`<promise>COMPLETE</promise>`. If a blocker needs a human decision, output
`<promise>BLOCKED</promise>`.
