# Persistent Artifacts

Save durable documents only when the user explicitly requests saving one or
invokes `$artifact`. Ordinary Q&A, coding, debugging, and reviews use chat and
the working tree. Existing documents are optional inputs: their status does
not authorize work, require a phase, or make their claims current. Reading an
artifact does not authorize updating it.

Use a requested destination. Otherwise the blueprint CLI remains the default
storage helper; its directories organize documents, not workflow stages:

| Content | Creation command |
| ------- | ---------------- |
| Plan or decision | `blueprint create proposal "<topic>" --status complete` |
| Review | `blueprint create review "<topic>" --status complete` |
| Context or diagnosis | `blueprint create report "<topic>" --status complete --kind <kind>` |
| Other report | `blueprint create report "<topic>" --status complete` |

For typed reports, use `context` or `diagnosis` as the kind. Capture the returned
path in `file`, write below the generated frontmatter, and run
`blueprint validate "$file"`. The CLI currently requires `status`; `complete`
means the document was written, not that proposed work is approved or finished.
Body headings are optional, including those generated for proposals. Do not
change status as work proceeds.

The CLI derives the project and creates timestamped Markdown files under
`~/workspace/blueprints/<project>/`. Use `blueprint find --type ... --match ...`
or an explicit file path to locate requested inputs. Resolve ambiguity before
editing; do not choose a document by recency unless the user asks for the
latest. Existing `spec/` and `plan/` documents remain readable.

Cite related documents with ordinary links. The optional command
`blueprint link <file> <source-slug>` records a source relationship; derive the
slug from the source's full filename stem. Links do not create dependencies or
approval obligations.

Saving does not include committing, pushing, archiving, or deleting artifacts.
Perform those actions only when requested. Report a failed save or validation
accurately; it does not invalidate completed analysis or block unrelated work.
