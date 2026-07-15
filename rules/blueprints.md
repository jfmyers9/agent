# Blueprints Convention

Blueprints are opt-in durable documents. Create one only when the user
explicitly invokes an artifact skill: `context`, `research`, `review`,
or `diagnose`.

Ordinary questions, coding, debugging, PR work, and branch management do not
create blueprints. They may consume an existing blueprint when the user names
one or when it is clearly relevant input.

## Project Derivation

Always use the CLI:

```sh
project=$(blueprint project)
```

## Directory Layout

```text
~/workspace/blueprints/<project>/proposal/  # decisions awaiting/after approval
~/workspace/blueprints/<project>/review/    # code and acceptance findings
~/workspace/blueprints/<project>/report/    # context, diagnosis, and reports
~/workspace/blueprints/<project>/archive/   # archived artifacts
```

Legacy `spec/` and `plan/` directories remain readable, findable, and
archivable. Do not create new files in them.

## Artifact Roles

- `proposal/`: one decision and implementation approach. Required sections:
  `Decision`, `Evidence`, `Approach`, `Acceptance Criteria`, and
  `Implementation Notes`. States: `draft -> approved -> complete`.
- `review/`: stable findings and their resolutions. Generated reviews are
  complete artifacts; resolution progress belongs in the body.
- `report/`: completed context and diagnosis reports, distinguished by
  `kind: context` or `kind: diagnosis`.

## Human Review

Research has one approval boundary. A new proposal is `draft`. Either an
explicit approval response or invoking `$implement <proposal>` authorizes the
work and advances it to `approved`. Feedback revises the same proposal.

## Naming And Writes

Files use `<epoch>-<slug>.md`. Generate slugs with:

```sh
blueprint slug "<text>"
```

Resolve a report subtype with `blueprint find --type report --kind <kind>`.
Explicit `--match` and `--exact` lookups reject ambiguity; use `--all` only when
the workflow intends to present multiple candidates.

After each artifact write, status change, or move, validate and commit the exact
file:

```sh
blueprint validate "$file"
blueprint commit <type> "$file"
```

The CLI refuses a pre-existing staged index and stages only the resolved file.
If commit or push fails, stop and show the error. Archive only when explicitly
asked:

```sh
blueprint archive <exact-or-unique-target>
```

## Linking

Use `source` only when one artifact derives from another:

```sh
blueprint link "$file" "<source-slug>"
```

Obsidian resolves the stored bare filename wikilink across directories.
