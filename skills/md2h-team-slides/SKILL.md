---
name: md2h-team-slides
description: Summarize a Markdown document as a concise team slide deck in md2h slides-compatible Markdown. Generate Markdown only; do not generate HTML. Use when asked to create a team slide summary from a Markdown file; use the document as the factual source.
---

# Team slide summary with md2h

Delegate Markdown deck creation and validation to one subagent using **`gpt-6.1-sol` with `medium` reasoning effort**. This skill is the entry point; the subagent performs the [deck workflow](references/deck-workflow.md).

1. Resolve the source document and any user-specified audience, length, and destination. Pass these constraints, the absolute source path, and the absolute path to `references/deck-workflow.md` to the subagent.
2. Spawn the worker with explicit model and effort settings. With `collaboration.spawn_agent`, use `model: "gpt-6-luna"`, `reasoning_effort: "high"`, and `fork_turns: "none"`; include all necessary task context in `message`. Tell the worker to read the workflow reference and complete it directly, without invoking this skill again or spawning another agent.
3. Wait for the worker to finish. Check its reported Markdown path and validation results, then deliver a link to the editable Markdown deck. Do not generate HTML or run the md2h renderer. Send any needed corrections back to the same worker.

If model-selectable subagents are unavailable or Sol cannot be selected, explain the limitation and ask whether to proceed with the current model. Do not silently substitute a model or claim that skill metadata changes the active model.
