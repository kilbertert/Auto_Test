# TASK

Merge the following branches into the current branch (main) and deliver them:

{{BRANCHES}}

For each branch:

1. Run `git merge <branch> --no-edit`
2. If there are merge conflicts, resolve them intelligently by reading both
   sides and choosing the correct resolution
3. After resolving conflicts, run `npm run check` to verify everything works
4. If tests fail, fix the issues before proceeding to the next branch

After all branches are merged, make a single Conventional Commit summarizing
the merge (e.g. `feat: ...` covering the merged work, or `merge: planner
iteration`), using `git commit --amend` on the merge commit if the default
message is not Conventional.

# DELIVERY (push main)

You are authorized to push to `main` from inside this environment:

1. Set the git identity and use the provided GitHub token:
   ```bash
   git config user.name "claude-code[bot]"
   git config user.email "claude-code[bot]@users.noreply.github.com"
   gh auth setup-git
   ```
2. Push the merged `main` to origin:
   ```bash
   git push origin main
   ```

# CLOSE ISSUES

For each branch that was merged, close its issue with a comment. If there are
parent issues (such as PRDs) whose closing the issue would complete, close
those too.

Here are all the issues:

{{ISSUES}}

Use `gh issue close <number> --comment "..."` for each.

Once you've merged, verified, pushed, and closed everything you can, output
`<promise>COMPLETE</promise>`. If a blocker needs a human decision, output
`<promise>BLOCKED</promise>`.
