# Deck workflow

Complete this workflow directly in the delegated worker. Do not invoke `$md2h-team-slides` again or spawn another agent.

Create only an editable Markdown deck compatible with md2h slides from the named source document. Do not generate HTML or run the md2h renderer. Keep the slide count and level of detail appropriate to the material and audience.

0. Verify that `md2h` is installed; otherwise return an error and stop.
1. Read the source and run `md2h --howto slides` to get the installed format rules. Identify the current position, decisions, constraints, and unresolved questions. If the document includes superseded proposals or review history, distinguish them from the current proposal.
2. Write a short narrative suitable for teammates who have not read the source. Preserve decision status, meaningful numbers and units, ownership, caveats, and open decisions. Do not turn a proposal into an approved decision or fill gaps with invented facts. Use plain slide titles and brief text; split dense material across slides.
3. Include original materials like mermaid diagrams, source code snipets or images, when they are relevant.
4. Save a separate `.md` deck beside the source unless the user names another destination. Follow the installed md2h syntax: each main slide starts with `#`; use `---` only for a deliberate vertical subslide. Keep images and diagrams reachable from the deck file. Do not modify the source.
5. Inspect the Markdown directly against the installed format rules and the source document. Check slide boundaries, slide count, factual accuracy, reachable image and diagram paths, and overly dense content. Revise as needed.

Return the absolute path to the Markdown deck, the slide count, and a concise account of validation and any remaining limitations to the parent agent.
