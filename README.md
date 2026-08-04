# CourtListener — Federal & State Court Opinions

Free Law Project's CourtListener. Federal and state court opinions, oral argument recordings, judge biographies, PACER filings (where covered). The largest free, structured database of US case law — used by lawyers, journalists, researchers. Free, no auth (rate-limited; key recommended for higher volume).

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1394+ live data sources.

## Why this matters for AI agents

For legal research, case-law citations, or "did this issue come up in court?" questions, CourtListener is the right starting point. Where Westlaw and Lexis charge thousands per seat, CourtListener provides searchable opinions for free. Coverage is excellent for federal courts and growing for state courts.

Common flows:

- **Opinion search.** "Cases involving Section 230 immunity" → keyword + jurisdiction filter.
- **Specific opinion.** Full text of a court opinion by ID or citation.
- **By judge.** "Cases authored by Justice Kagan" → search by author + court.
- **Oral arguments.** Audio recordings (where available) with metadata.

## Auth

Free, but unauthenticated calls are heavily rate-limited (~5,000/day per IP). Get a free API token from https://www.courtlistener.com/help/api/rest/ for higher rates. Pass via `_apiKey`.

## Coverage

| Jurisdiction class | Coverage |
|---|---|
| US Supreme Court | Comprehensive, modern + historical |
| Federal Circuit Courts of Appeals | Strong; recent + retrospective |
| Federal District Courts | Strong for published opinions; partial for unpublished |
| State Supreme Courts | Generally strong |
| State Appellate Courts | Varies by state |
| State Trial Courts | Spotty |

For "what's the law on X?" the supreme courts and circuit courts are usually what matters; trial-court opinions are less precedential.

## Common pitfalls

- **Citation format.** US case-law citations follow `Bluebook` conventions: `Roe v. Wade, 410 U.S. 113 (1973)`. CourtListener's IDs differ from these; use the `cluster_id` or `slug` fields for stable references.
- **Published vs unpublished.** Federal courts mark opinions "published" (precedential) or "unpublished" (binding only on parties). Unpublished doesn't mean unimportant — many recent significant opinions stayed unpublished. Don't filter to "published" without thought.
- **Citation network.** CourtListener tracks "cited by" and "cites to" relationships. Use them for impact analysis ("which Supreme Court opinions have shaped this doctrine?").
- **PACER limitations.** The full PACER (federal trial-court filings) corpus is paywalled. CourtListener has a partial mirror via the RECAP project, donated by users. Coverage is opportunistic, not comprehensive.
- **State coverage is uneven.** Don't assume "no opinion found in CourtListener" means "no opinion exists" — especially for state appellate cases. Cross-reference with state-court websites or commercial databases for completeness.
- **Search is keyword + cluster, not full text.** Long-tail queries like specific phrasings may underperform. Use CL's "+ exact phrase" syntax when precision matters.

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

Or connect to the full Pipeworx gateway for access to all 1394+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Court Listener data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
