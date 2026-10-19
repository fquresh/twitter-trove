# Wiki schema

This file is the schema for the Trove wiki.
`wiki_bootstrap.py` copies it to `wiki/CLAUDE.md` when that file is missing.
It then sends the copy to the model as the system prompt.
Edit `wiki/CLAUDE.md` to change the page format for your own wiki.
The folder `wiki/` is not tracked by git.

## Purpose

The wiki holds short synthesis pages about the people, concepts, and tickers in the collection.
The chat agent reads these pages before it reads single posts.
Every claim on a page must come from a source post.

## Folders

| Folder | Page type | File name |
|---|---|---|
| `wiki/people/` | `person` | The lowercase handle without `@`, for example `ada_fieldstone.md`. |
| `wiki/concepts/` | `concept` | A lowercase slug of the category name, for example `agents.md`. |
| `wiki/tickers/` | `ticker` | The lowercase ticker symbol, for example `nvda.md`. |

A file name uses only the characters `a-z`, `0-9`, `.`, `_`, and `-`.
`wiki_server.py` rejects any other name.
The files `wiki/index.md` and `wiki/CHANGELOG.md` are not pages.

## Page format

Each page starts with a frontmatter block.
Use flat `key: value` lines and inline lists only.
The server does not parse nested YAML.

```markdown
---
type: person
display: "@ada_fieldstone"
slug: ada_fieldstone
source_tweet_ids: ["1800000000000000001", "1800000000000000002"]
last_updated_iso: 2026-01-15T09:30:00Z
last_updated_by: bootstrap
confidence: medium
---

# @ada_fieldstone

One or two sentences that say who this is and why the collection holds their posts.

## Main themes

- Theme one, stated in one sentence. [^1800000000000000001]
- Theme two, stated in one sentence. [^1800000000000000002]

## Open questions

- One line about what the posts do not settle.

## Related

- [[concepts/agents]]
```

## Frontmatter keys

| Key | Rule |
|---|---|
| `type` | One of `person`, `concept`, `ticker`. |
| `display` | The name to show. Use `"@handle"` for a person. |
| `slug` | The file name without `.md`. |
| `source_tweet_ids` | Quoted strings. Quotes keep long ids exact. |
| `last_updated_iso` | UTC time in the form `YYYY-MM-DDTHH:MM:SSZ`. The agent uses it to judge if a page is stale. |
| `last_updated_by` | `bootstrap` for the first pass. Use another word for a later pass. |
| `confidence` | `high` for 10 or more consistent posts. `medium` for 3 to 9. `low` for fewer. |

## Writing rules

1. Use only the source posts in the request. Do not add outside facts.
2. Cite every claim with a post id in the form `[^1234567890]`.
3. Link to other pages with `[[folder/slug]]`, for example `[[people/ada_fieldstone]]`.
4. Keep a page under 400 words.
5. Write short sentences. Write one idea in each sentence.
6. State disagreement between posts. Do not hide it.
7. Do not give financial advice on a ticker page. Describe what the posts say.
8. Output only the page. Do not add a code fence or a comment outside the page.

## Index and change log

`wiki/index.md` has a hand-written top and a machine-managed part.
Text below the line `<!-- machine-managed below -->` is rewritten on each run.
`wiki/CHANGELOG.md` is an append-only log.
Each line has a UTC time, the actor, a verb, the page path, and a note.
