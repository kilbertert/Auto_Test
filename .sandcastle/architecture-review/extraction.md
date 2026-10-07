# EMIT STRUCTURED OUTPUT

You have finished the architecture-review pass. **Do not explore further or make any changes** — only report the outcome.

End your response with a single `<output>` block, exactly as specified in the project skill `improve-codebase-architecture-project`. It has one of two shapes.

The `title` and `body` you emit are what the workflow will publish as the issue — you do not create it yourself. Report the PRD you drafted, not one you opened.

## Proposed a PRD this run

<output>
{
  "status": "proposed",
  "title": "PRD title — this becomes the issue title",
  "body": "The full PRD body — this becomes the issue body.",
  "oneLineSummary": "One-line description of the deepening opportunity.",
  "candidatesConsidered": ["candidate 1", "candidate 2"]
}
</output>

## Skipped — everything fresh is already covered

<output>
{
  "status": "skipped",
  "reason": "Why no new PRD was proposed (e.g. every candidate is already covered by a prior source:architecture-review proposal)."
}
</output>

Field rules:

- `status` — `"proposed"` or `"skipped"`. Required.
- `title` — required when proposed; ≤256 characters.
- `body` — required when proposed; the full PRD body.
- `oneLineSummary` — required when proposed.
- `candidatesConsidered` — required when proposed; non-empty array of strings.
- `reason` — required when skipped.

Do not add fields beyond those listed. The JSON is machine-parsed.
