# CourtListener — US case law

US court opinions from Free Law Project's CourtListener: **8.3 million opinions
across 3,361 courts**, going back to 1761. The largest free, structured database
of American case law.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1476+ live data sources.

Most of it is **state** law. That surprises people, and it is the point:

| | Opinions | Share |
|---|---|---|
| State (supreme, appellate, trial) | 6,219,869 | **71%** |
| Federal (incl. SCOTUS 498,145) | 2,440,856 | 28% |
| Territorial, military, tribal | 86,691 | 1% |

Federal appellate law is easy to find elsewhere. Six million state opinions,
assembled and addressable, are not.

## Auth

**None** for case lookup and opinion text — no key, no signup, no rate limit.

`search_opinions` and `search_dockets` search upstream by topic and are subject
to CourtListener's throttling. A free token from Free Law Project lifts it.

## Tools

| Tool | Use it when |
|---|---|
| `find_case` | You know what the case is **called** — "Roe v. Wade", or just "Sullivan" |
| `lookup_citation` | You have a reporter citation — "410 U.S. 113" |
| `list_case_opinions` | You have a case and want its majority, concurrences and dissents |
| `get_opinion` | You have an opinion id and want the **full text** |
| `search_opinions` | Case search by name, judge or category (mirror-first; a specific `court` code searches live) |
| `search_dockets` | Docket-level search, upstream |
| `list_docket_filings` | You have a `docket_id` and want the **docket sheet** — what was filed, when |
| `get_docket_filing` | You have a `document_id` and want that one filing + its PDF |
| `search_court_filings` | You want the **text of filings** — motions, briefs, orders — not opinions |

For litigation documents the path is `search_dockets` → `list_docket_filings` →
`get_docket_filing`. Every filing tool is keyed by `docket_id`, and only
`search_dockets` produces one — a PACER case number will not resolve.

Opinions and filings answer different questions: an opinion is what a court
**decided**, a filing is what the parties **filed**.

`search_opinions` returns one `cases` shape whichever path served it (mirror or
live), and the most-cited case inlines an `excerpt` of its lead opinion — the
opening, its holding language, and the query match — so "what did the court
hold" is answerable from the search result alone; `get_opinion` reads the full
text.

The usual path is `find_case` → `list_case_opinions` → `get_opinion`. Results
from `find_case` and `lookup_citation` are ranked by **citation count**, because
among cases sharing a name the one later courts actually cite is nearly always
the one being asked about — "roe wade" returns the 1973 Supreme Court decision
(5,581 citations) ahead of the 1970 district case (53).

### Abbreviated and copy-pasted case names

Name matching is AND over every token, so one token the corpus does not carry
sinks the whole lookup. That used to mean `find_case` returned nothing for
`Bell Atl. Corp. v. Twombly` — the corpus stores "Bell Atlantic Corp.", and
`atl` does not stem to `atlant` — and nothing for a name pasted out of a brief
with its scaffold attached (`TABLE OF AUTHORITIES Bowers v. Hardwick`).

When the name as given matches nothing, `find_case` now retries once with
Bluebook abbreviations, citation scaffold and corporate suffixes **dropped**
(never expanded or guessed — under AND semantics dropping a token can only
widen). A result found that way is labelled:

```json
{ "matched": "relaxed", "matched_query": "Bell v Twombly", "note": "…" }
```

Treat a `matched: "relaxed"` hit as a best-effort resolution of a messy
citation and check the returned `case_name` is the case you meant. An exact
match never carries the field, and a name that matches on the first pass still
costs exactly one query.

## Coverage

**Keyless:** opinion full text, case names, filing dates, judges, precedential
status, citation counts, reporter citations.

**Upstream, throttled:** full-text *topic* search, and all three filing tools.
Finding a case by topic can fail in a way that finding it by name or citation
cannot.

**RECAP filings (PACER documents) — keyless, via search only.** ~9.7 million
documents. The REST endpoints you would reach for, `/recap-documents/` and
`/docket-entries/`, both answer *"Authentication credentials were not
provided"*; `/search/?type=rd` needs no token and is the path the filing tools
use. Scoping goes through the `q` field query (`q=docket_id:71886217`) — passing
`?docket_id=` as a parameter is **silently ignored** and returns the whole
61.7M-document corpus rather than an error.

## Caveats worth passing to a user

- **A filing without a PDF is still a real filing.** RECAP holds docket *text*
  for far more entries than it holds documents, because a PDF only exists once
  somebody has paid PACER for it. Each filing reports `pdf_available`; on a
  typical docket most entries are metadata-only. Read a missing PDF as "nobody
  has bought this one", never as "this was not filed".
- **Filing tools spend a scarce budget.** They go upstream to CourtListener's
  `/search/`, throttled to roughly **125 requests a day** without a token —
  the same throttle the opinion mirror exists to avoid. There is no mirror for
  RECAP. When it is exhausted the tools say so explicitly rather than returning
  an empty docket; opinion tools are unaffected.
- **Recency.** Responses carry a `snapshot_date`; opinions filed after it fall
  through to upstream search.
- **14.2% of the corpus is OCR** of scanned volumes and reads accordingly.
  Responses set `extracted_by_ocr` so garbled text is attributable to the scan
  rather than to us.
- **`date_created` is not a filing date.** It is when the record entered
  CourtListener — a 1946 opinion can read 2020. `date_filed`, joined from the
  cluster, is when the court actually ruled.
- **Citation counts are within CourtListener's corpus**, not a universal measure
  of importance.

## Attribution

Data is CourtListener / Free Law Project, published under the Public Domain
Mark. Free Law Project funds and maintains the corpus. If this pack is useful to
you, <https://free.law/donate/> is where that goes.

<!-- Maintainers: refresh procedure and design notes are in
     docs/courtlistener-mirror-plan.md (internal). -->

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "court-listener": {
      "url": "https://gateway.pipeworx.io/court-listener/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/court-listener/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1476+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Court Listener data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
