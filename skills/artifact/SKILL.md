---
name: artifact
description: >
  Save a useful plan, review, context map, or investigation as a persistent
  Markdown input for later work. Invoke explicitly when a durable document is
  wanted; ordinary questions, coding, and reviews stay in chat by default.
disable-model-invocation: true
user-invocable: true
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
argument-hint: "<what to save or investigate> [destination]"
---

# Artifact

Write a concise document that another prompt can use without this conversation.

@rules/blueprints.md, @rules/artifact-readability.md, and
@rules/harness-compat.md apply.

1. Determine the requested subject, purpose, and destination from the prompt.
   Reuse relevant conversation evidence. Investigate missing details only as
   needed to make the document useful; do not rerun completed work merely to
   populate a template. Saving a document does not authorize product changes.
2. Read explicitly supplied inputs and check claims the document will rely on
   against current evidence. Preserve uncertainty and distinguish observations
   from inference. When saving prior findings without revalidation, retain
   their original snapshot and say they have not been rechecked.
3. Choose a structure that fits the purpose. These are content suggestions,
   not required sections:
   - Plan or decision: objective, constraints, alternatives, recommendation,
     actionable changes, and observable success criteria.
   - Context: scope, entrypoints, ownership, important flows, invariants,
     representative tests, and questions worth checking next.
   - Diagnosis: symptoms, reproduction, competing explanations, evidence for
     and against, confidence, and the next discriminating observation. Source
     presence alone does not establish runtime reachability or deployment.
   - Review: target and scope, conclusion, evidenced findings, concrete impact,
     and checks performed. Preserve supplied finding IDs when useful.
4. Save to the requested destination, or use the blueprint storage convention.
   Update an existing document only when requested; reading it as input does
   not authorize edits. Preserve unrelated content and user changes. For a
   blueprint, preserve generated frontmatter, replace unnecessary boilerplate,
   and run `blueprint validate "$file"` after writing.
5. Return the path and any material evidence gaps. The document is context for
   future instructions; do not assign approval state, prescribe a next skill,
   commit, or push as part of saving it.
