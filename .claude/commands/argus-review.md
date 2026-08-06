---
description: Run the Argus governed code review (Gemini via agy) on the working diff
argument-hint: [extra argus flags, e.g. --project my-app --no-refine]
allowed-tools: Bash(mkdir:*), Bash(git diff:*), Bash(node dist/cli.mjs:*)
---

!`mkdir -p .argus`
!`git diff HEAD > .argus/pending.diff`
!`node dist/cli.mjs .argus/pending.diff --provider antigravity $ARGUMENTS`

Above is Argus's review of the current working diff, produced by a *different* model
family (Gemini, via the `agy` CLI) than the one reading this.

Summarize the findings grouped by severity. Before you accept any finding, open the
cited file and confirm it — Argus reviews from a token-budgeted context slice, so it
can cite a line it only partially saw, and it is a second opinion to check rather than
ground truth. Say explicitly which findings you confirmed, which you could not
reproduce, and which you disagree with. Then propose concrete fixes for the confirmed
ones.
