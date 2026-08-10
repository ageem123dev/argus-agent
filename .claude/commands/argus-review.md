---
description: Run the Argus governed code review (Gemini via agy) on this branch's changes
argument-hint: [extra argus flags, e.g. --project my-app --no-refine]
allowed-tools: Bash(node dist/cli.mjs:*)
---

!`node dist/cli.mjs diff --repo . --out .argus/pending.diff`
!`node dist/cli.mjs .argus/pending.diff --provider antigravity $ARGUMENTS`

Above is Argus's review, produced by a *different* model family (Gemini, via the
`agy` CLI) than the one reading this.

The diff covers this branch's committed work, anything uncommitted, and files git does
not track yet -- the same body of code a reviewer running against the base branch sees.
If the first command reported nothing to review, say so and stop rather than reviewing
an empty diff.

Summarize the findings grouped by severity. Before you accept any finding, open the
cited file and confirm it -- Argus reviews from a token-budgeted context slice, so it
can cite a line it only partially saw, and it is a second opinion to check rather than
ground truth. Say explicitly which findings you confirmed, which you could not
reproduce, and which you disagree with. Then propose concrete fixes for the confirmed
ones.
