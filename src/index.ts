interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * CourtListener MCP — Free Law Project's CourtListener API (free, no auth required for basic access)
 *
 * Tools:
 * - search_opinions: search court opinions by keyword
 * - search_dockets: search court dockets by keyword
 * - get_opinion: get a specific opinion by ID
 */


const BASE = 'https://www.courtlistener.com/api/rest/v4';

// ── Types ─────────────────────────────────────────────────────────────

type CLOpinion = {
  id?: number | null;
  absolute_url?: string | null;
  cluster?: string | null;
  author_str?: string | null;
  type?: string | null;
  date_created?: string | null;
  date_modified?: string | null;
  sha1?: string | null;
  download_url?: string | null;
  plain_text?: string | null;
  html?: string | null;
  html_lawbox?: string | null;
  html_columbia?: string | null;
};

type CLSearchResult = {
  count?: number;
  next?: string | null;
  results: Record<string, unknown>[];
};

type CLDocket = {
  id?: number | null;
  absolute_url?: string | null;
  case_name?: string | null;
  case_name_short?: string | null;
  court?: string | null;
  court_id?: string | null;
  date_filed?: string | null;
  date_terminated?: string | null;
  docket_number?: string | null;
  nature_of_suit?: string | null;
  cause?: string | null;
  assigned_to_str?: string | null;
  referred_to_str?: string | null;
};

// ── Helpers ───────────────────────────────────────────────────────────

function formatSearchResult(r: Record<string, unknown>) {
  return {
    id: r.id ?? null,
    caseName: r.caseName ?? r.case_name ?? null,
    court: r.court ?? r.court_id ?? null,
    dateFiled: r.dateFiled ?? r.date_filed ?? null,
    docketNumber: r.docketNumber ?? r.docket_number ?? null,
    suitNature: r.suitNature ?? r.nature_of_suit ?? null,
    snippet: r.snippet ?? null,
    absolute_url: r.absolute_url ?? null,
    status: r.status ?? null,
  };
}

function formatDocket(d: CLDocket) {
  return {
    id: d.id ?? null,
    case_name: d.case_name ?? null,
    case_name_short: d.case_name_short ?? null,
    court: d.court ?? d.court_id ?? null,
    date_filed: d.date_filed ?? null,
    date_terminated: d.date_terminated ?? null,
    docket_number: d.docket_number ?? null,
    nature_of_suit: d.nature_of_suit ?? null,
    cause: d.cause ?? null,
    assigned_to: d.assigned_to_str ?? null,
    referred_to: d.referred_to_str ?? null,
    url: d.absolute_url ?? null,
  };
}

// ── Tool definitions ──────────────────────────────────────────────────

const tools: McpToolExport['tools'] = [
  {
    name: 'search_opinions',
    description:
      'Search US court opinions by keyword (e.g., "qualified immunity", "Fourth Amendment"). Returns case name, court, date, docket number, and text snippet. Covers federal and state courts.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search keywords (e.g., "patent infringement software")' },
        court: { type: 'string', description: 'Court filter (e.g., "scotus" for Supreme Court, "ca9" for 9th Circuit)' },
        date_after: { type: 'string', description: 'Only opinions after this date (YYYY-MM-DD)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_dockets',
    description:
      'Search US court dockets by keyword. Returns case name, court, filing date, docket number, nature of suit, and assigned judge. Covers PACER and RECAP archives.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search keywords (e.g., "antitrust merger")' },
        court: { type: 'string', description: 'Court filter (e.g., "nysd" for Southern District of New York)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_opinion',
    description:
      'Get a specific court opinion by its CourtListener ID. Returns the full opinion text, author, date, and download link.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'CourtListener opinion ID (numeric)' },
      },
      required: ['id'],
    },
  },
];

// ── callTool dispatcher ───────────────────────────────────────────────

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'search_opinions':
      return searchOpinions(
        args.query as string,
        args.court as string | undefined,
        args.date_after as string | undefined,
      );
    case 'search_dockets':
      return searchDockets(args.query as string, args.court as string | undefined);
    case 'get_opinion':
      return getOpinion(args.id as number);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── Tool implementations ─────────────────────────────────────────────

async function searchOpinions(query: string, court?: string, dateAfter?: string) {
  const params = new URLSearchParams({
    q: query,
    type: 'o',
    order_by: 'score desc',
  });
  if (court) params.set('court', court);
  if (dateAfter) params.set('filed_after', dateAfter);

  const res = await fetch(`${BASE}/search/?${params}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`CourtListener API error: ${res.status}`);

  const data = (await res.json()) as CLSearchResult;

  return {
    query,
    total: data.count ?? data.results.length,
    returned: data.results.length,
    opinions: data.results.map(formatSearchResult),
  };
}

async function searchDockets(query: string, court?: string) {
  const params = new URLSearchParams({
    q: query,
    type: 'r',
    order_by: 'score desc',
  });
  if (court) params.set('court', court);

  const res = await fetch(`${BASE}/search/?${params}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`CourtListener API error: ${res.status}`);

  const data = (await res.json()) as CLSearchResult;

  return {
    query,
    total: data.count ?? data.results.length,
    returned: data.results.length,
    dockets: data.results.map(formatSearchResult),
  };
}

async function getOpinion(id: number) {
  const res = await fetch(`${BASE}/opinions/${id}/`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`CourtListener API error (${res.status}): opinion ${id} not found`);

  const data = (await res.json()) as CLOpinion;

  // Extract text content from available fields
  const text = data.plain_text || data.html || data.html_lawbox || data.html_columbia || null;

  return {
    id: data.id ?? id,
    author: data.author_str ?? null,
    type: data.type ?? null,
    date_created: data.date_created ?? null,
    download_url: data.download_url ?? null,
    url: data.absolute_url ? `https://www.courtlistener.com${data.absolute_url}` : null,
    text: text ? (text.length > 5000 ? text.slice(0, 5000) + '...[truncated]' : text) : null,
  };
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
