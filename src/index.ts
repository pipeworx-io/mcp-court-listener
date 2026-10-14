interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Shared full-text-search helpers for every caller of the FTS5 case/statute
 * search shard (workers/gateway/src/search-shard.ts, `op match ?`).
 *
 * THE BUG THIS FIXES (fleet #3070). Several packs sent the caller's raw text
 * straight into FTS5's MATCH operator. A comma, a '?', or an AND/OR/NOT/NEAR
 * in the question is FTS5 syntax, so the shard throws a SQLite error — and
 * the pack reported that as `index_unreachable`, an infrastructure failure,
 * when the real problem was punctuation in a plain-language question. Even
 * once the syntax is sanitized, ANDing every word of a whole sentence
 * ("what does X require") returns zero hits, because no statute section
 * contains the literal word "what" — a silent, wrong "no match" for what is
 * actually a query-shape problem, not an absence of an answer.
 *
 * Two packs independently built the identical fix — illinois-code
 * (bdc38b2c2) and france-legi's core.ts — before this existed. Lifted here so
 * every other caller of the shard (north-carolina-code, indiana-code,
 * wyoming-code, the court-listener case-law fan-out in caselaw-search.ts, and
 * any future statute pack) gets it for free instead of re-deriving it a
 * third, fourth, fifth time.
 */

type FtsMode = 'all' | 'any';

/**
 * Caller text -> a safe FTS5 MATCH expression. Every word (or quoted phrase)
 * is re-quoted as an FTS5 string literal, so FTS5 operators (AND/OR/NOT/
 * NEAR), column filters, and stray punctuation in a plain-language question
 * — commas, question marks, the very things a real caller's sentence is full
 * of — cannot change the query's meaning or throw a syntax error. Non-letter,
 * non-digit characters are simply dropped by the `\p{L}\p{N}` match, which is
 * what turns "bond, and license" (a syntax error against `op match ?`) into
 * a clean three-term query.
 *
 * `mode: 'all'` ANDs every term (precise, for a short deliberate query);
 * `mode: 'any'` ORs them (a relaxed retry for a whole sentence — see
 * `shardSearch` below, which is the fallback policy this exists to support).
 *
 * `extraTerm`, when given, is ANDed on as its own already-resolved literal
 * (e.g. a jurisdiction/code token every hit must also carry). Resolving a
 * caller-facing id into that literal — france-legi's `codeToken` — is the
 * caller's job, not this function's; this only assembles the final MATCH
 * string.
 *
 * Returns null when the text has no searchable words at all (e.g. "???").
 */
function ftsQuery(text: string, mode: FtsMode, extraTerm?: string | null): string | null {
  const parts: string[] = [];
  const re = /"([^"]+)"|([\p{L}\p{N}]+)/gu;
  for (const m of text.matchAll(re)) {
    const raw = m[1] ?? m[2];
    const words = raw.match(/[\p{L}\p{N}]+/gu);
    if (!words?.length) continue;
    parts.push(`"${words.join(' ')}"`);
  }
  if (!parts.length) return null;
  const body = parts.length === 1 ? parts[0] : mode === 'all' ? parts.join(' AND ') : `(${parts.join(' OR ')})`;
  return extraTerm ? `${body} AND "${extraTerm}"` : body;
}

interface FtsHit {
  opinion_id: number;
  score: number;
}

interface FtsShardResult {
  hits: FtsHit[];
  /** Which query actually produced `hits`. Null only when the text had no
   *  searchable words at all (`ftsQuery` returned null) and the shard was
   *  never called. */
  mode: FtsMode | null;
  /** False only on a genuine shard/transport failure — non-2xx, a network
   *  error, or a body that doesn't parse. That is a real infrastructure
   *  problem and callers MUST report it as one (e.g. `index_unreachable`).
   *  A legitimate zero-hit search still reports `ok: true` with `hits: []`
   *  — callers MUST NOT collapse that distinction (silent-zero-policy). */
  ok: boolean;
}

interface ShardStub {
  fetch(url: string, init: RequestInit): Promise<Response>;
}

/**
 * Query ONE shard stub with the ALL->ANY fallback: try an ALL-words match
 * first (the precise read of a short, deliberate query — "currency exchange
 * license fee"), and only retry with an OR-ranked ANY-word match when the
 * query has more than one word and the ALL attempt came back empty. A long
 * plain-language question ANDs every one of its words, including stopwords
 * like "what" or "does" that statute/opinion text is unlikely to contain
 * verbatim — that AND-of-a-sentence zero is not evidence the answer is
 * absent, it's the ALL mode being too strict for a sentence shaped input.
 * bm25's own idf weighting discounts a word that appears in nearly every
 * document, so the ANY retry needs no separate stopword list (same reasoning
 * search-shard.ts's own "NO STOPWORD LIST" note gives for not stripping
 * function words from the index itself).
 */
async function shardSearch(
  stub: ShardStub,
  text: string,
  limit: number,
  extraTerm?: string | null,
): Promise<FtsShardResult> {
  const runQuery = async (matchQuery: string): Promise<FtsHit[]> => {
    const res = await stub.fetch('https://shard/query', {
      method: 'POST',
      body: JSON.stringify({ q: matchQuery, limit }),
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) throw new Error(`shard_http_${res.status}`);
    const out = (await res.json()) as { results?: FtsHit[] };
    return out.results ?? [];
  };

  const allQuery = ftsQuery(text, 'all', extraTerm);
  if (!allQuery) return { hits: [], mode: null, ok: true };

  try {
    let hits = await runQuery(allQuery);
    let mode: FtsMode = 'all';
    if (!hits.length && /\s/.test(text)) {
      const anyQuery = ftsQuery(text, 'any', extraTerm);
      if (anyQuery) {
        hits = await runQuery(anyQuery);
        mode = 'any';
      }
    }
    return { hits, mode, ok: true };
  } catch {
    return { hits: [], mode: null, ok: false };
  }
}


/**
 * Fan out a full-text query across the case-law search shards and merge.
 *
 * Lives in shared because both the gateway (which owns the binding) and the
 * court-listener pack (which owns the tool) need it, and a copy in each would
 * drift the moment the ranking changes.
 *
 * The index is FTS5 inside SQLite-backed Durable Objects — six of them, because
 * one holds 10 GB and the index is ~46 GB. See workers/gateway/src/search-shard.ts.
 *
 * QUERY SAFETY (fleet #3070). This used to send the caller's raw text into
 * every shard's `op match ?` and never checked `res.ok` before parsing the
 * body — so a comma or '?' in the question threw a SQLite FTS5 syntax error
 * inside the shard (a 500 with `{error:'shard_error',...}`), and because the
 * body was parsed unconditionally, `out.results` came back `undefined`,
 * `?? []` turned that into an empty hit list, and EVERY shard "answered"
 * with zero results — a real infrastructure failure read as a clean,
 * confident "no case matches", the worse of the two silent-zero shapes.
 * `ftsQuery` (shared, also used by illinois-code/france-legi/the state
 * statute packs) now quotes the text into a safe MATCH expression before it
 * ever reaches a shard, `queryShards` below throws on a non-2xx response so
 * a shard error counts as NOT answered rather than as an empty answer, and
 * an ALL-words miss retries ANY-word once across all shards before giving up
 * — the same ALL->ANY fallback the single-shard statute packs use.
 */


const SHARD_COUNT = 6;

function shardIds(): number[] {
  return Array.from({ length: SHARD_COUNT }, (_, i) => i);
}

interface SearchHit {
  opinion_id: number;
  score: number;
  shard: number;
  citation_count?: number;
}

/**
 * Query every shard and merge into one ranking.
 *
 * THE PROBLEM. bm25 scores are not comparable across shards: each is computed
 * against its own corpus statistics, so identical relevance produces different
 * numbers depending on which shard a case landed in. Merging raw scores ranks
 * by shard membership, which is meaningless.
 *
 * THE FIRST FIX WAS ALSO WRONG. Normalising each shard onto 0..1 by its own
 * range removes the scale — but it maps every shard's best hit to exactly 1.0,
 * so with six shards the top six results tie at the ceiling and their order is
 * arbitrary. Observed live: three results, all relevance 1.0.
 *
 * WHAT ACTUALLY RANKS CASE LAW. How often later courts cite a case is a far
 * stronger signal of which one you meant than term frequency is, and unlike
 * bm25 it is GLOBAL — a citation count means the same thing in every shard.
 * Blending a normalised text score with a normalised citation score gives an
 * ordering that is comparable across shards and matches how lawyers actually
 * rank authority. A case cited 5,000 times should beat a textual near-match
 * nobody has ever cited, and now it does.
 *
 * The text score still matters: citation count alone would return the same
 * famous cases for every query.
 */
/** Fan one already-safe MATCH expression out across all six shards and merge.
 *  A shard that errors (non-2xx, network failure, bad JSON) is REJECTED, not
 *  counted as answered with zero hits — the fix for the silent-zero bug
 *  described above. */
async function queryShards(
  ns: DurableObjectNamespace,
  matchQuery: string,
  perShard: number,
): Promise<{ pooled: SearchHit[]; answered: number }> {
  const settled = await Promise.allSettled(
    shardIds().map(async (s) => {
      const stub = ns.get(ns.idFromName(`shard-${s}`));
      const r = await stub.fetch('https://shard/query', {
        method: 'POST',
        body: JSON.stringify({ q: matchQuery, limit: perShard }),
        headers: { 'Content-Type': 'application/json' },
      });
      if (!r.ok) throw new Error(`shard_http_${r.status}`);
      const out = (await r.json()) as { results?: { opinion_id: number; score: number }[] };
      return (out.results ?? []).map((h) => ({ ...h, shard: s }));
    }),
  );

  const answered = settled.filter((r) => r.status === 'fulfilled');
  const pooled: SearchHit[] = [];
  for (const r of answered) {
    const hits = (r as PromiseFulfilledResult<SearchHit[]>).value;
    if (!hits.length) continue;
    // bm25 is negative, more-negative is better. Rescale within the shard so
    // shards become comparable in ordering, then blend with a global signal so
    // the ties this creates get broken by something meaningful.
    const scores = hits.map((h) => h.score);
    const best = Math.min(...scores);
    const worst = Math.max(...scores);
    const span = worst - best || 1;
    for (const h of hits) pooled.push({ ...h, score: (worst - h.score) / span });
  }
  return { pooled, answered: answered.length };
}

async function searchCaseLaw(
  ns: DurableObjectNamespace | undefined,
  q: string,
  limit: number,
  opts: { supabaseUrl?: string; supabaseKey?: string } = {},
): Promise<{ results: SearchHit[]; shards_answered: number; ranking_note: string; match: FtsMode | null }> {
  if (!ns) {
    return {
      results: [],
      shards_answered: 0,
      ranking_note: 'search shards are not reachable from this deployment',
      match: null,
    };
  }

  // Over-fetch per shard: the blend can reorder substantially, so merging only
  // each shard's top few would discard cases that the citation signal promotes.
  const perShard = Math.min(100, Math.max(limit * 3, 30));

  const allQuery = ftsQuery(q, 'all');
  if (!allQuery) {
    // No searchable words at all (e.g. "???") — this is a fact about the
    // query, not about the shards, so it must not read as index_unreachable.
    return {
      results: [],
      shards_answered: SHARD_COUNT,
      ranking_note: 'query contained no searchable words',
      match: null,
    };
  }

  let { pooled, answered } = await queryShards(ns, allQuery, perShard);
  let mode: FtsMode = 'all';
  // Same ALL->ANY fallback as the single-shard statute packs: a whole
  // plain-language question ANDs stopwords no opinion contains verbatim, so
  // an ALL-mode zero across healthy shards gets one relaxed OR retry before
  // this is reported as "nothing matched".
  if (!pooled.length && answered > 0 && /\s/.test(q)) {
    const anyQuery = ftsQuery(q, 'any');
    if (anyQuery) {
      const retry = await queryShards(ns, anyQuery, perShard);
      pooled = retry.pooled;
      answered = Math.max(answered, retry.answered);
      mode = 'any';
    }
  }

  const cites = await citationCounts(pooled.map((h) => h.opinion_id), opts);
  // log1p, not raw: citation counts are power-law distributed (Miranda has
  // 58,288, the median cited case has a handful), and a linear blend would let
  // a single famous case dominate every query regardless of what was asked.
  const maxLog = Math.max(...pooled.map((h) => Math.log1p(cites.get(h.opinion_id) ?? 0)), 1);
  const ranked = pooled
    .map((h) => {
      const cc = cites.get(h.opinion_id) ?? 0;
      const authority = Math.log1p(cc) / maxLog;
      return { ...h, citation_count: cc, score: 0.6 * h.score + 0.4 * authority };
    })
    .sort((a, b) => b.score - a.score);

  return {
    results: ranked.slice(0, limit),
    shards_answered: answered,
    ranking_note:
      'Relevance blends BM25 text match (60%) with how often later courts have cited the case (40%, log-scaled). Citation count is global, so it makes results comparable across shards in a way BM25 alone is not.',
    match: mode,
  };
}

/** Citation counts for the pooled hits, in one request. Ranking degrades to
 *  text-only if this fails — a worse order beats no answer. */
async function citationCounts(
  opinionIds: number[],
  opts: { supabaseUrl?: string; supabaseKey?: string },
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (!opts.supabaseUrl || !opts.supabaseKey || opinionIds.length === 0) return out;
  try {
    const ids = [...new Set(opinionIds)].slice(0, 600).join(',');
    const res = await fetch(
      `${opts.supabaseUrl}/rest/v1/courtlistener_opinions` +
        `?id=in.(${ids})&select=id,courtlistener_clusters!inner(citation_count)&limit=600`,
      { headers: { apikey: opts.supabaseKey, Authorization: `Bearer ${opts.supabaseKey}` } },
    );
    if (!res.ok) {
      // No embedded relationship available (no FK), so fall back to two hops.
      return await citationCountsTwoHop(opinionIds, opts);
    }
    for (const r of (await res.json()) as {
      id: number;
      courtlistener_clusters?: { citation_count?: number };
    }[]) {
      out.set(r.id, r.courtlistener_clusters?.citation_count ?? 0);
    }
  } catch {
    return out;
  }
  return out;
}

async function citationCountsTwoHop(
  opinionIds: number[],
  opts: { supabaseUrl?: string; supabaseKey?: string },
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  try {
    const ids = [...new Set(opinionIds)].slice(0, 600).join(',');
    const oRes = await fetch(
      `${opts.supabaseUrl}/rest/v1/courtlistener_opinions?id=in.(${ids})&select=id,cluster_id&limit=600`,
      { headers: { apikey: opts.supabaseKey!, Authorization: `Bearer ${opts.supabaseKey!}` } },
    );
    if (!oRes.ok) return out;
    const ops = (await oRes.json()) as { id: number; cluster_id: number | null }[];
    const clusterIds = [...new Set(ops.map((o) => o.cluster_id).filter(Boolean))];
    if (!clusterIds.length) return out;
    const cRes = await fetch(
      `${opts.supabaseUrl}/rest/v1/courtlistener_clusters?id=in.(${clusterIds.join(',')})&select=id,citation_count&limit=600`,
      { headers: { apikey: opts.supabaseKey!, Authorization: `Bearer ${opts.supabaseKey!}` } },
    );
    if (!cRes.ok) return out;
    const byCluster = new Map<number, number>();
    for (const c of (await cRes.json()) as { id: number; citation_count: number }[]) {
      byCluster.set(c.id, c.citation_count ?? 0);
    }
    for (const o of ops) out.set(o.id, byCluster.get(o.cluster_id ?? -1) ?? 0);
  } catch {
    return out;
  }
  return out;
}


/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * CourtListener MCP — Free Law Project's CourtListener API (v4).
 *
 * Auth, precisely: upstream /search/ is open but throttled, and every upstream
 * DETAIL endpoint (opinions, clusters, dockets by id) returns 401 without a
 * token. A free token from Free Law Project lifts the search throttling, which
 * was rejecting more than half of real search calls. Case lookup and opinion
 * text do not go through those endpoints and need no token.
 *
 * Tools:
 * - search_opinions: search court opinions by case name / judge / category
 *   (mirror-first, keyless — fleet #166; falls back upstream for filings
 *   after the mirror's snapshot_date or for a court more specific than
 *   state/federal, which the mirror does not carry). BOTH paths return the
 *   same `cases` shape, and the most-cited case inlines a lead-opinion
 *   excerpt so a single grounded call can answer a holding question
 *   (fleet #381)
 * - search_dockets: search court dockets by keyword (upstream — not yet
 *   mirrored; courtlistener_dockets lives in a separate Supabase project
 *   after a bulk load of it crashed production on 2026-08-08)
 * - find_case: case by name, ranked by citation count (keyless)
 * - lookup_citation: reporter citation -> case (keyless)
 * - list_case_opinions: majority/concurrence/dissent for a case (keyless)
 * - get_opinion: full opinion text by id (keyless)
 */


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'Court Listener');
}


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


// ── Helpers ───────────────────────────────────────────────────────────

const clUrl = (path: unknown): string | null =>
  typeof path === 'string' && path ? `https://www.courtlistener.com${path}` : null;

/**
 * ONE case shape for search_opinions, whichever path served it (fleet #381).
 *
 * The mirror path used to return `cases` (snake_case metadata) and the live
 * fallback `opinions` (camelCase rows with `total`/`truncated`), so which
 * contract a caller got was decided by whether an OPTIONAL `court` argument
 * happened to be filled — and single-call grounding could parse one shape but
 * not the other. Both paths now emit this object, keys identical, null where
 * a path genuinely does not know a value.
 *
 * Live search results carry NO top-level `id` — the real identifiers are
 * `cluster_id` (the case), `docket_id`, and the nested `opinions[].id` (the
 * individual opinion documents; a case can have majority + dissent +
 * concurrence, so `opinion_ids` is a list, not a scalar).
 */
function liveCase(r: Record<string, unknown>) {
  const nested = Array.isArray(r.opinions) ? (r.opinions as Record<string, unknown>[]) : [];
  const opinionIds = nested.map((o) => o.id).filter((v): v is number => typeof v === 'number');
  return {
    cluster_id: (r.cluster_id as number | undefined) ?? null,
    docket_id: (r.docket_id as number | undefined) ?? null,
    case_name: (r.caseName as string | undefined) ?? null,
    case_name_full: null as string | null,
    date_filed: (r.dateFiled as string | undefined) ?? null,
    judges: (r.judge as string | undefined) ?? null,
    precedential_status: (r.status as string | undefined) ?? null,
    citation_count: (r.citeCount as number | undefined) ?? null,
    citations: Array.isArray(r.citation)
      ? (r.citation as unknown[]).filter((c): c is string => typeof c === 'string')
      : typeof r.citation === 'string' && r.citation
        ? [r.citation]
        : [],
    disposition: null as string | null,
    // `opinion_id` is what get_opinion takes; `opinion_ids` exposes the rest
    // (dissents/concurrences) rather than pretending a case has one opinion.
    opinion_id: opinionIds[0] ?? null,
    opinion_ids: opinionIds,
    // Live search snippets are usually empty; the most-cited case gets a real
    // excerpt from the mirrored opinion text after this formatter runs.
    excerpt: ((r.snippet as string | undefined) || null) as string | null,
    url: clUrl(r.absolute_url),
    read_with: opinionIds[0]
      ? `get_opinion({id: ${opinionIds[0]}})`
      : r.cluster_id
        ? `list_case_opinions({cluster_id: ${r.cluster_id}})`
        : null,
  };
}

type UnifiedCase = ReturnType<typeof liveCase>;

/** Docket search results key on `docket_id`, likewise absent from `r.id`. */
function formatDocketResult(r: Record<string, unknown>) {
  return {
    docket_id: r.docket_id ?? null,
    caseName: r.caseName ?? null,
    court: r.court ?? r.court_id ?? null,
    dateFiled: r.dateFiled ?? null,
    dateTerminated: r.dateTerminated ?? null,
    docketNumber: r.docketNumber ?? null,
    suitNature: r.suitNature ?? null,
    cause: r.cause ?? null,
    assigned_to: r.assignedTo ?? null,
    pacer_case_id: r.pacer_case_id ?? null,
    snippet: r.snippet ?? null,
    url: clUrl(r.absolute_url),
  };
}

/**
 * CourtListener's /search/ endpoint IGNORES page_size — it always returns 20 per
 * page and pages via a `next` cursor (verified 2026-08-04: page_size=1, =50 and
 * =100 all return 20). So `limit` cannot be pushed upstream; it is honoured by
 * following the cursor and slicing. MAX_PAGES bounds how much one call can cost.
 */
const PAGE = 20;
const MAX_PAGES = 5;

/**
 * Repair unbalanced parentheses before spending a round trip on the query.
 *
 * CourtListener's search is Elasticsearch `query_string`, where `(` and `)` are
 * grouping operators — so one stray paren is a 400 for the whole request, not a
 * literal character to match on. That is not a hypothetical: on 2026-08-17 every
 * single `search_dockets` error was this, and every one came from our own
 * internal legal backfill feeding us case names it had scraped out of opinion
 * text with the tail of a citation still attached — `In re Goldberg)`,
 * `Cir.1996). 164 Broussard v. Jazz Casino Co. LLC`, `D). See United States v.
 * Hughes`. The names were fine; the closing paren belonged to `(Bankr. S.D.N.Y.
 * 2019)` upstream of the extractor. Dropping it returns 35,373 matches for
 * `In re Goldberg` where the raw string returned a 400. (fleet #431)
 *
 * Only UNBALANCED input is touched. A caller who writes
 * `(fraud OR deceit) AND securities` means those parens as operators and gets
 * them through untouched — silently rewriting a valid grouping would be a worse
 * bug than the one this fixes.
 *
 * Parens inside a double-quoted phrase are literal to Elasticsearch and so are
 * not counted, and a backslash-escaped paren is the caller saying "match this
 * character" — both are left exactly as written.
 */
export function balanceParens(q: string): string {
  const drop = new Set<number>();
  const open: number[] = [];
  let inQuote = false;

  for (let i = 0; i < q.length; i++) {
    const c = q[i];
    if (c === '\\') { i++; continue; }          // escaped char — never an operator
    if (c === '"') { inQuote = !inQuote; continue; }
    if (inQuote) continue;
    if (c === '(') open.push(i);
    else if (c === ')') {
      if (open.length) open.pop();
      else drop.add(i);                          // closer with nothing to close
    }
  }
  for (const i of open) drop.add(i);             // opener never closed

  if (!drop.size) return q;
  let out = '';
  for (let i = 0; i < q.length; i++) if (!drop.has(i)) out += q[i];
  // Collapse the whitespace the removal can strand ("Cir.1996 ). 164" -> one gap).
  return out.replace(/\s{2,}/g, ' ').trim();
}

async function searchPaged(params: URLSearchParams, limit: number) {
  // Every CourtListener /search/ call in this pack funnels through here —
  // search_case_law's live path, search_dockets, search_court_filings and
  // list_docket_filings — so the paren repair sits here rather than at each
  // call site, where the next tool added would have missed it.
  const rawQ = params.get('q');
  if (rawQ) {
    const fixed = balanceParens(rawQ);
    if (fixed !== rawQ) params.set('q', fixed);
  }
  const results: Record<string, unknown>[] = [];
  let url: string | null = `${BASE}/search/?${params}`;
  let total: number | null = null;
  let pages = 0;

  while (url && results.length < limit && pages < MAX_PAGES) {
    const res: Response = await pwFetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw await httpError(res, 'CourtListener API error');
    const data = (await res.json()) as CLSearchResult;
    if (total === null && typeof data.count === 'number') total = data.count;
    results.push(...data.results);
    url = typeof data.next === 'string' ? data.next : null;
    pages++;
  }

  return {
    rows: results.slice(0, limit),
    total: total ?? results.length,
    truncated: results.length > limit || (results.length === limit && pages >= MAX_PAGES),
  };
}

function limitArg(v: unknown, dflt = PAGE): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 1), PAGE * MAX_PAGES) : dflt;
}

// ── Tool definitions ──────────────────────────────────────────────────

const tools: McpToolExport['tools'] = [
  {
    name: 'search_opinions',
    description:
      'Search US court opinions from CourtListener — 8.3 million of them, with no API key and no rate limit. Covers the UNITED STATES SUPREME COURT (SCOTUS), the federal circuit courts of appeals, the federal district courts, and the state courts (71% of the corpus is state case law). THE tool for what a US court HELD, decided or ruled in a NAMED CASE — "What did the Supreme Court hold in Air France v. Saks?", "Miranda v. Arizona", "the Ninth Circuit ruling in ..." — including the treaty and statutory questions such cases turn on (Warsaw Convention, ERISA, the Fourth Amendment). Matches the case name, the judge, and (where CourtListener recorded one) a nature-of-suit/disposition category, so it is strongest on party names, judges, and case categories ("workers compensation", "habeas", "immigration") and weaker on a legal DOCTRINE that would not appear in those fields (e.g. "qualified immunity") — use find_case when you know the party, and expect this to sometimes miss on doctrine-only phrasing. Filter by jurisdiction (state vs federal, inferred from the citation reporter) and by date_filed (the real ruling date). A specific court code (e.g. "scotus", "ca9") or a filing after the covered window falls back to a live, token-less CourtListener search automatically. Every result carries snapshot_date and opinion_ids to read with get_opinion.',
    summary: 'US court opinions matching a keyword search, from CourtListener\'s 8.3 million opinions across state and federal courts.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search keywords — strongest on party names, judges and case categories (e.g. "workers compensation", "Sotomayor").' },
        jurisdiction: { type: 'string', enum: ['state', 'federal'], description: 'Filter to state or federal case law (inferred from the reporter citation).' },
        court: { type: 'string', description: 'A specific court code (e.g. "scotus", "ca9", "nysd"). Not available on the indexed search — supplying this falls back to a live CourtListener search.' },
        date_after: { type: 'string', description: 'Only opinions with a real filing date (date_filed) on or after this date (YYYY-MM-DD).' },
        date_before: { type: 'string', description: 'Only opinions with a real filing date (date_filed) on or before this date (YYYY-MM-DD).' },
        limit: { type: 'number', description: 'How many cases to return, 1–100 (default 10).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_dockets',
    description:
      'Search US court dockets by keyword. Covers PACER and RECAP archives. Each result carries docket_id, case name, court, filing and termination dates, docket number, nature of suit, the cause of action, the assigned judge, and the PACER case id.',
    summary: 'US federal court dockets matching a keyword search, from the PACER/RECAP archive.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search keywords (e.g., "antitrust merger")' },
        court: { type: 'string', description: 'Court filter (e.g., "nysd" for Southern District of New York)' },
        limit: { type: 'number', description: 'How many dockets to return, 1–100 (default 20). CourtListener pages at 20, so higher values fetch additional pages.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_case_law',
    description:
      'Search the FULL TEXT of US court opinions by subject matter — "qualified immunity for police dogs", "securities fraud scienter pleading standard". Searches the full text of CourtListener opinions with no API key and no rate limit, and returns the most relevant opinion ids, a relevance score and how often each case has been cited; set include_snippets for a passage around the match, or call get_opinion to read the whole thing. Use this when you know the TOPIC. To find a case by NAME use find_case; by reporter citation use lookup_citation. Phrase queries need quotes.',
    summary: 'US court opinions matching a full-text subject search, from CourtListener\'s 8.3 million opinions.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Subject matter to search for. Quote phrases: "clear and present danger".' },
        limit: { type: 'number', description: 'Maximum opinions to return (1-50, default 10).' },
        include_snippets: { type: 'boolean', description: 'Return a passage of text around the match for each result (default false). Costs one extra fetch per result, so leave it off when you only need ids.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'find_case',
    description:
      'Find a US court case BY NAME and get its citations, filing date, judges and how often it has been cited. Searches 8.3 million opinions across 3,361 courts — no API key, no rate limit. Ranked by citation count, so the leading case for a name comes first. Use this when you know what the case is CALLED; use search_opinions when you only know the TOPIC.',
    summary: 'A US court case\'s citations, filing date and judges, found by case name, from CourtListener.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Case name or a distinctive party, e.g. "Roe v. Wade" or "Sullivan".' },
        limit: { type: 'number', description: 'Maximum cases to return (1-25, default 5).' },
      },
      required: ['name'],
    },
  },
  {
    name: 'lookup_citation',
    description:
      'Resolve a US reporter citation such as "410 U.S. 113" or "347 U.S. 483" to the case it refers to, with name, filing date, judges and citation count. No API key, no rate limit. Use when a brief, opinion or article cites a case by reporter and you need to know which case that is.',
    summary: 'The case a US reporter citation (e.g. "410 U.S. 113") refers to, from CourtListener.',
    inputSchema: {
      type: 'object',
      properties: {
        citation: { type: 'string', description: 'Reporter citation: volume, reporter, page. E.g. "410 U.S. 113".' },
      },
      required: ['citation'],
    },
  },
  {
    name: 'list_case_opinions',
    description:
      'List every opinion filed in one case (cluster) — majority, concurrences and dissents — with the opinion_id needed to read each one via get_opinion. No API key, no rate limit. Use after find_case or lookup_citation to get from a case to its readable text.',
    summary: 'Every opinion filed in one US court case — majority, concurrences, dissents — from CourtListener.',
    inputSchema: {
      type: 'object',
      properties: {
        cluster_id: { type: 'number', description: 'Cluster id from find_case or lookup_citation.' },
      },
      required: ['cluster_id'],
    },
  },
  {
    name: 'get_opinion',
    description:
      'Get the FULL TEXT of a US court opinion by its CourtListener opinion ID (the opinion_id returned by search_opinions). Covers 8.3 million opinions, 71% state case law — no API key needed. Returns the opinion text, the case name, the real filing date, author, citation count, whether the text came from OCR of a scan, and the data as-of date. Opinions filed after that date may fall through to live search.',
    summary: 'The full text of one US court opinion by its CourtListener id.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'CourtListener opinion ID (numeric)' },
      },
      required: ['id'],
    },
  },
  {
    name: 'list_docket_filings',
    description:
      'List the filings on a US FEDERAL district or bankruptcy court docket — every complaint, motion, order and exhibit RECAP has recorded for that case, in filing order, with the document id, entry number, filing date, page count and a link to the PDF. This is the docket sheet: what was filed, when, and by which entry number. Each filing reports whether its PDF is actually held (`pdf_available`); RECAP holds the docket text for far more filings than it holds documents, so treat a filing with no PDF as a real filing whose document nobody has purchased yet, not as a missing record. Takes the docket_id from search_dockets. Court opinions are a different thing and live in search_case_law / get_opinion.',
    summary: 'Every filing on one US federal court docket, in filing order, from the PACER/RECAP archive.',
    inputSchema: {
      type: 'object',
      properties: {
        docket_id: { type: 'number', description: 'Docket id from search_dockets (the docket_id field).' },
        limit: { type: 'number', description: 'Maximum filings to return (default 20).' },
      },
      required: ['docket_id'],
    },
  },
  {
    name: 'get_docket_filing',
    description:
      'Get one filing from a US federal court docket by its document id — the entry description as the clerk wrote it, the filing date, page count, the docket_id it belongs to, a text excerpt where the document has been scanned, and a direct PDF link. Use after list_docket_filings or search_court_filings to read a specific document. Returns pdf_available false when RECAP has the docket entry but not the document itself.',
    summary: 'One filing from a US federal court docket, by its RECAP document id.',
    inputSchema: {
      type: 'object',
      properties: {
        document_id: { type: 'number', description: 'RECAP document id, from list_docket_filings or search_court_filings.' },
      },
      required: ['document_id'],
    },
  },
  {
    name: 'search_court_filings',
    description:
      'Search the TEXT of US federal court filings — complaints, motions, briefs, orders and exhibits from PACER as archived in RECAP, roughly 9.7 million documents. Use this to find what was actually argued or ordered in litigation ("trade secret misappropriation", a company named as a defendant, a specific contract term), as opposed to the appellate opinions that search_case_law covers. Returns the filing description as the clerk wrote it, the filing date, a matching text excerpt, a PDF link where the document is held, and the docket_id to read the rest of that case with list_docket_filings. Quote a phrase to search it exactly.',
    summary: 'US federal court filings — complaints, motions, orders — matching a text search, from PACER/RECAP.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search text. Quote a phrase for an exact match.' },
        court: { type: 'string', description: 'Optional court code to narrow to, e.g. "cand" or "txsd".' },
        limit: { type: 'number', description: 'Maximum filings to return (default 20).' },
      },
      required: ['query'],
    },
  },
];

// ── callTool dispatcher ───────────────────────────────────────────────

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'search_opinions':
      return searchOpinions(mirrorFromArgs(args), {
        query: args.query as string,
        jurisdiction: args.jurisdiction as string | undefined,
        court: args.court as string | undefined,
        dateAfter: args.date_after as string | undefined,
        dateBefore: args.date_before as string | undefined,
        // Default 10, not 20: results now inline an opinion excerpt, and the
        // whole payload has to fit single-call grounding's 8,000-char budget.
        limit: limitArg(args.limit, 10),
      });
    case 'search_dockets':
      return searchDockets(args.query as string, args.court as string | undefined, limitArg(args.limit));
    case 'get_opinion':
      return getOpinion(args.id as number, args);
    case 'search_case_law':
      return searchCaseLawTool(args);
    case 'find_case':
      return findCase(mirrorFromArgs(args), args.name as string,
        Math.min(25, Math.max(1, Number(args.limit) || 5)));
    case 'lookup_citation':
      return lookupCitation(mirrorFromArgs(args), args.citation as string, args._d1);
    case 'list_case_opinions':
      return listCaseOpinions(mirrorFromArgs(args), Number(args.cluster_id));
    case 'list_docket_filings':
      return listDocketFilings(Number(args.docket_id), limitArg(args.limit));
    case 'get_docket_filing':
      return getDocketFiling(Number(args.document_id));
    case 'search_court_filings':
      return searchCourtFilings(args.query as string, args.court as string | undefined, limitArg(args.limit));
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── Tool implementations ─────────────────────────────────────────────

interface SearchOpinionsArgs {
  query: string;
  jurisdiction?: string;
  court?: string;
  dateAfter?: string;
  dateBefore?: string;
  limit: number;
}

/** Only 'state' | 'federal' map onto the mirror's reporter-based heuristic. */
function normalizeJurisdiction(v: string | undefined): 'state' | 'federal' | undefined {
  const s = (v ?? '').trim().toLowerCase();
  return s === 'state' || s === 'federal' ? s : undefined;
}

async function mirrorSnapshotDate(m: NonNullable<Mirror>): Promise<string | null> {
  const rows = await pg<{ snapshot_date: string }>(
    m, 'courtlistener_snapshots?select=snapshot_date&order=snapshot_date.desc&limit=1');
  return rows[0]?.snapshot_date ?? null;
}

async function searchOpinionsMirror(
  m: NonNullable<Mirror>, query: string, jurisdiction: 'state' | 'federal' | undefined,
  dateAfter: string | undefined, dateBefore: string | undefined, limit: number,
): Promise<ClusterRow[]> {
  const params = new URLSearchParams({ q: query, lim: String(Math.min(limit, 25)) });
  if (jurisdiction) params.set('jurisdiction', jurisdiction);
  if (dateAfter) params.set('date_after', dateAfter);
  if (dateBefore) params.set('date_before', dateBefore);
  return pg<ClusterRow>(m, `rpc/search_opinions_mirror?${params}`);
}

// ── Inline excerpts for grounding (fleet #381) ───────────────────────
//
// A holding question ("what did the Supreme Court hold in X") is graded by a
// SINGLE grounded call against this tool's payload. Metadata alone can never
// answer it, so the most-cited case in a result carries `excerpt`: passages
// from its lead opinion. The passages are chosen for where holdings actually
// live — verified on Air France v. Saks, whose "we conclude that liability…"
// sits at char ~21,500 of 29,728, unreachable by either a head slice or a
// first-keyword window:
//   1. the opening (who ruled, and the question presented),
//   2. windows around holding language ("we hold", "we conclude", "held
//      that", "it is so ordered") — first and last match when there are many,
//   3. a window around the longest query term, if not already covered.
// The whole payload must stay under the grounding path's 8,000-char budget
// (above it the gateway head-truncates or, past 16,000, runs a second
// embedding pass with a measured OOM risk — fleet #376), which is why only
// ONE case gets text and the windows are sized as they are.

const EXCERPT_HEAD = 800;
const EXCERPT_ANCHOR_WINDOW = 800;
const EXCERPT_TERM_WINDOW = 600;
/** Don't decompress a monster opinion just for an excerpt. */
const EXCERPT_MAX_BYTES = 4_000_000;

const HOLDING_ANCHOR =
  /\b(?:we\s+(?:now\s+|therefore\s+|thus\s+|accordingly\s+)?(?:hold|conclude)|held\s+that|it is so ordered)\b/gi;

function excerptFromText(text: string, query: string): string {
  const spans: Array<[number, number]> = [[0, EXCERPT_HEAD]];

  const anchors: number[] = [];
  for (const mm of text.matchAll(HOLDING_ANCHOR)) anchors.push(mm.index ?? 0);
  const picks = anchors.length <= 2 ? anchors : [anchors[0], anchors[anchors.length - 1]];
  for (const at of picks) {
    const start = Math.max(0, at - 100);
    spans.push([start, start + EXCERPT_ANCHOR_WINDOW]);
  }

  // Longest query term, as snippetFor does — only when no span covers it yet.
  const terms = query
    .replace(/["']/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 3)
    .sort((a, b) => b.length - a.length);
  const lower = text.toLowerCase();
  for (const t of terms) {
    const at = lower.indexOf(t.toLowerCase());
    if (at < 0) continue;
    if (!spans.some(([s, e]) => at >= s && at < e)) {
      const start = Math.max(0, at - 100);
      spans.push([start, start + EXCERPT_TERM_WINDOW]);
    }
    break;
  }

  spans.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [s, e] of spans) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  return merged
    .map(([s, e]) =>
      (s > 0 ? '… ' : '') +
      text.slice(s, e).replace(/\s+/g, ' ').trim() +
      (e < text.length ? ' …' : ''))
    .join(' ');
}

/** Lower = more primary. CourtListener types are numeric-prefixed ("010combined") or bare words. */
function opinionTypeRank(t: string | null): number {
  const s = (t ?? '').toLowerCase();
  if (s.includes('combined')) return 0;
  if (s.includes('unanimous')) return 1;
  if (s.includes('lead') || s.includes('majority')) return 2;
  if (s.includes('plurality')) return 3;
  if (s.includes('concurrence')) return 5;
  if (s.includes('dissent')) return 6;
  return 4;
}

type OpinionLite = Pick<MirrorRow, 'id' | 'cluster_id' | 'type' | 'pack_no' | 'byte_offset' | 'byte_length' | 'snapshot_date'>;

/** Opinion documents for a set of cases, lead opinion first within each. */
async function opinionsByCluster(
  m: NonNullable<Mirror>, clusterIds: number[],
): Promise<Map<number, OpinionLite[]>> {
  const map = new Map<number, OpinionLite[]>();
  if (!clusterIds.length) return map;
  const rows = await pg<OpinionLite>(
    m,
    `courtlistener_opinions?cluster_id=in.(${clusterIds.join(',')})` +
      `&select=id,cluster_id,type,pack_no,byte_offset,byte_length,snapshot_date&limit=200`,
  );
  for (const r of rows) {
    if (typeof r.cluster_id !== 'number') continue;
    const list = map.get(r.cluster_id) ?? [];
    list.push(r);
    map.set(r.cluster_id, list);
  }
  for (const list of map.values()) {
    list.sort((a, b) => opinionTypeRank(a.type) - opinionTypeRank(b.type) || a.id - b.id);
  }
  return map;
}

/** The one case whose opinion text is worth inlining: the most-cited match. */
function excerptTarget<T extends { citation_count: number | null }>(cases: T[]): T | null {
  let best: T | null = null;
  for (const c of cases) {
    if (typeof c.citation_count !== 'number') continue;
    if (!best || c.citation_count > (best.citation_count ?? -1)) best = c;
  }
  return best ?? cases[0] ?? null;
}

async function excerptFromMirror(
  m: NonNullable<Mirror>, lead: OpinionLite | undefined, query: string,
): Promise<string | null> {
  if (!lead || lead.byte_length > EXCERPT_MAX_BYTES) return null;
  try {
    const text = await mirrorText(m, lead);
    return text ? excerptFromText(text, query) : null;
  } catch {
    return null; // an excerpt is a bonus, never the reason a search fails
  }
}

/**
 * Mirror-first (fleet #166). The mirror carries case_name, judges and (thin
 * coverage — nature_of_suit is populated on ~1.9% of clusters, mostly
 * federal) a suit category, indexed as one combined tsvector — it is a case
 * lookup, not a full-opinion-text search, and the tool description says so.
 *
 * Upstream is used, not the mirror, when: (a) the mirror is unreachable,
 * (b) `court` names a specific court the mirror cannot filter on (it has no
 * per-court column — only the state/federal split inferred from citation
 * reporters), or (c) date_after asks for filings after the mirror's own
 * snapshot_date, which by definition it cannot hold.
 *
 * A ZERO-row mirror match does NOT fall back upstream automatically — that
 * would silently re-import the 125-request/day throttle this path exists to
 * escape. It returns found:false with a hint instead.
 */
async function searchOpinions(m: Mirror, a: SearchOpinionsArgs) {
  const jurisdiction = normalizeJurisdiction(a.jurisdiction) ?? normalizeJurisdiction(a.court);
  // A `court` value that is not literally "state"/"federal" names a specific
  // court (e.g. "ca9") the mirror cannot filter on — honor it upstream rather
  // than silently ignoring it.
  const wantsSpecificCourt = !!a.court && !jurisdiction;

  if (m && !wantsSpecificCourt) {
    const snapshotDate = await mirrorSnapshotDate(m);
    const pastSnapshot = !!(a.dateAfter && snapshotDate && a.dateAfter > snapshotDate);
    if (!pastSnapshot) {
      const rows = await searchOpinionsMirror(m, a.query, jurisdiction, a.dateAfter, a.dateBefore, a.limit);
      if (rows.length) {
        const clusterIds = rows.map((r) => r.id);
        const [byCluster, opsByCluster] = await Promise.all([
          citationsFor(m, clusterIds),
          opinionsByCluster(m, clusterIds),
        ]);
        const cases: UnifiedCase[] = rows.map((r) => {
          const ops = opsByCluster.get(r.id) ?? [];
          return {
            cluster_id: r.id,
            docket_id: r.docket_id ?? null,
            case_name: r.case_name,
            case_name_full: r.case_name_full,
            date_filed: r.date_filed,
            judges: r.judges,
            precedential_status: r.precedential_status,
            citation_count: r.citation_count,
            citations: byCluster.get(r.id) ?? [],
            disposition: r.disposition ?? null,
            opinion_id: ops[0]?.id ?? null,
            opinion_ids: ops.map((o) => o.id),
            excerpt: null,
            url: `https://www.courtlistener.com/opinion/${r.id}/`,
            read_with: ops[0]
              ? `get_opinion({id: ${ops[0].id}})`
              : `list_case_opinions({cluster_id: ${r.id}})`,
          };
        });
        const target = excerptTarget(cases);
        if (target && target.cluster_id) {
          target.excerpt = await excerptFromMirror(
            m, opsByCluster.get(target.cluster_id)?.[0], a.query);
        }
        return {
          query: a.query,
          jurisdiction: jurisdiction ?? null,
          court: a.court ?? null,
          total: null,
          returned: rows.length,
          truncated: rows.length >= Math.min(a.limit, 25),
          cases,
          source: 'court-listener',
          snapshot_date: rows[0]?.snapshot_date ?? snapshotDate,
          note: 'Matched on case name, judge, and/or nature-of-suit category — not full opinion text. The most-cited case carries `excerpt`: passages from its lead opinion (the opening, its holding language, and the query match) — enough to ground what the court held. Full text of any opinion: get_opinion({id: opinion_id}). This search covers filings through snapshot_date; pass a date_after beyond it to extend the search to more recent filings.',
          attribution: 'CourtListener / Free Law Project — Public Domain Mark.',
        };
      }
      return {
        query: a.query,
        jurisdiction: jurisdiction ?? null,
        court: a.court ?? null,
        total: 0,
        returned: 0,
        truncated: false,
        cases: [],
        found: false,
        source: 'court-listener',
        snapshot_date: snapshotDate,
        hint: 'No case matched by name, judge, or nature-of-suit/disposition category. Full opinion text is not indexed, so a legal DOCTRINE term (e.g. "qualified immunity") can miss even where relevant opinions exist — try find_case for a party name, broaden the term, or supply a specific `court` to search CourtListener live instead.',
        attribution: 'CourtListener / Free Law Project — Public Domain Mark.',
      };
    }
  }

  // Upstream fallback: mirror unavailable, a specific court was requested, or
  // date_after reaches past the mirror's snapshot_date. SAME payload shape as
  // the mirror path — which shape a caller gets must not depend on whether an
  // optional argument was filled (fleet #381).
  const params = new URLSearchParams({ q: a.query, type: 'o', order_by: 'score desc' });
  if (a.court) params.set('court', a.court);
  if (a.dateAfter) params.set('filed_after', a.dateAfter);
  // date_before used to be dropped here, so a bounded window ("Q3 only")
  // came back with every filing since date_after, up to today, as if the
  // bound had been honoured (fleet #2835). Same YYYY-MM-DD form as
  // filed_after; verified against v4 2026-10-08: negligence 2026-07-01..07-10
  // = 173 hits, unbounded = 1,402 reaching 2026-10-07.
  if (a.dateBefore) params.set('filed_before', a.dateBefore);

  const { rows, total, truncated } = await searchPaged(params, a.limit);
  const cases: UnifiedCase[] = rows.map(liveCase);
  // Live rows share the mirror's opinion-id space, so the most-cited case can
  // still carry real opinion text when the mirror holds it.
  if (m) {
    const target = excerptTarget(cases);
    if (target?.opinion_id) {
      const row = await mirrorRow(m, target.opinion_id);
      target.excerpt = (await excerptFromMirror(m, row ?? undefined, a.query)) ?? target.excerpt;
    }
  }
  return {
    query: a.query,
    jurisdiction: jurisdiction ?? null,
    court: a.court ?? null,
    total,
    returned: cases.length,
    truncated,
    cases,
    source: 'court-listener-live',
    snapshot_date: null,
    note: 'Live CourtListener search (used for a specific court code, or for filings after the covered window). total is the full match count; returned is what this call fetched. The most-cited case carries `excerpt`: passages from its lead opinion, where the text is available. Full text of any opinion: get_opinion({id: opinion_id}).',
    attribution: 'CourtListener / Free Law Project — Public Domain Mark.',
  };
}

async function searchDockets(query: string, court?: string, limit = PAGE) {
  const params = new URLSearchParams({ q: query, type: 'r', order_by: 'score desc' });
  if (court) params.set('court', court);

  const { rows, total, truncated } = await searchPaged(params, limit);
  return {
    query,
    total,
    returned: rows.length,
    truncated,
    dockets: rows.map(formatDocketResult),
  };
}

/**
 * Cut a readable window around the first query term in an opinion.
 *
 * Contentless FTS5 cannot do this — there is no stored text to excerpt — so the
 * text comes from R2 by byte offset, the same read get_opinion uses.
 *
 * Matching here is deliberately simple: the longest query term, case-insensitive.
 * FTS5 matched with a porter stemmer, so an exact substring hit is not
 * guaranteed; when none is found the opening of the opinion is returned and
 * `matched` says so, rather than pretending the head of the document is the
 * relevant passage.
 */
async function snippetFor(
  m: NonNullable<Mirror>,
  opinionId: number,
  query: string,
  window = 320,
): Promise<{ snippet: string; matched: boolean } | null> {
  const row = await mirrorRow(m, opinionId);
  if (!row) return null;
  const text = await mirrorText(m, row);
  if (!text) return null;

  const terms = query
    .replace(/["']/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 3)
    .sort((a, b) => b.length - a.length);

  let at = -1;
  for (const t of terms) {
    at = text.toLowerCase().indexOf(t.toLowerCase());
    if (at >= 0) break;
  }
  const matched = at >= 0;
  const start = matched ? Math.max(0, at - Math.floor(window / 3)) : 0;
  const raw = text.slice(start, start + window).replace(/\s+/g, ' ').trim();
  return {
    snippet: (start > 0 ? '…' : '') + raw + (start + window < text.length ? '…' : ''),
    matched,
  };
}

// ── Full-text search over the indexed corpus ──────────────────────────
//
// find_case answers "what is the case called X". This answers "what cases are
// about X", which is the question an agent actually starts with and the one
// that previously had to go upstream to CourtListener's 125-requests-a-day API.
//
// The index is FTS5 in SQLite-backed Durable Objects, fanned out across six
// shards. Results are opinion ids and a relevance score; the TEXT is not
// returned here because it lives in R2 and can be large — get_opinion fetches
// it by id, which is also how a caller pages through results without pulling
// megabytes they will not read.

async function searchCaseLawTool(args: Record<string, unknown>) {
  const q = String(args.query ?? '').trim();
  if (!q) {
    return {
      found: false,
      reason: 'empty_query',
      message: 'search_case_law needs a query.',
      hint: 'Search by subject matter — "qualified immunity for police dogs". To find a case by NAME use find_case, and by citation use lookup_citation.',
    };
  }
  const limit = Math.min(50, Math.max(1, Number(args.limit) || 10));
  const ns = args._searchShards as DurableObjectNamespace | undefined;
  // The mirror credentials come along so ranking can read citation counts;
  // without them the blend degrades to text-only rather than failing.
  const out = await searchCaseLaw(ns, q, limit, {
    supabaseUrl: args._supabaseUrl as string | undefined,
    supabaseKey: args._supabaseKey as string | undefined,
  });

  if (!out.results.length) {
    return {
      found: false,
      query: q,
      shards_answered: out.shards_answered,
      // Distinguishing "nothing matched" from "nothing answered" matters: one
      // is a fact about the law, the other is a fact about our infrastructure,
      // and a caller must not read the second as the first.
      message: out.shards_answered === 0
        ? 'The search index did not answer. This is an infrastructure failure, not an absence of matching cases.'
        : `No opinion in the index matched "${q}".`,
      hint: 'Try fewer or more common terms. Phrase queries need quotes: "beyond a reasonable doubt". The index covers opinions that have been cited at least once — an uncited procedural order will not appear.',
    };
  }

  // Snippets only for the page being returned, and only when asked: each one
  // is a range read plus a gunzip, and a caller that wants ids should not pay
  // for text it will not read.
  const wantSnippets = args.include_snippets === true;
  const mirror = mirrorFromArgs(args);
  const snippets = new Map<number, { snippet: string; matched: boolean }>();
  if (wantSnippets && mirror) {
    const got = await Promise.all(
      out.results.map(async (r) => [r.opinion_id, await snippetFor(mirror, r.opinion_id, q)] as const),
    );
    for (const [id, sn] of got) if (sn) snippets.set(id, sn);
  }

  return {
    query: q,
    returned: out.results.length,
    shards_answered: out.shards_answered,
    match: out.match === 'any' ? 'any_word' : out.match === 'all' ? 'all_words' : null,
    results: out.results.map((r) => ({
      opinion_id: r.opinion_id,
      relevance: Math.round(r.score * 1000) / 1000,
      // Surfaced, not just used: how often later courts cited a case is the
      // main reason it ranks where it does, and a caller weighing two results
      // deserves to see it rather than trust an opaque score.
      citation_count: r.citation_count ?? null,
      ...(snippets.has(r.opinion_id)
        ? {
            snippet: snippets.get(r.opinion_id)!.snippet,
            // Said plainly: FTS5 matched with a stemmer, so an exact substring
            // may not exist. false means this is the opening of the opinion,
            // not the passage that matched.
            snippet_is_match: snippets.get(r.opinion_id)!.matched,
          }
        : {}),
      read_with: `get_opinion({id: ${r.opinion_id}})`,
    })),
    ranking_note: out.ranking_note,
    source: 'CourtListener opinions, full-text search',
    attribution: 'CourtListener / Free Law Project — Public Domain Mark.',
  };
}

// ── Front door: find a case without CourtListener's search ────────────
//
// Until these existed the mirror had exactly one way in — a numeric opinion id
// the caller had to already possess — so every real lookup still travelled
// through CourtListener's throttled /search/. These answer the two ways a case
// is actually identified: by name, and by reporter citation.

interface ClusterRow {
  id: number;
  case_name: string | null;
  case_name_full: string | null;
  date_filed: string | null;
  judges: string | null;
  precedential_status: string | null;
  citation_count: number;
  docket_id: number | null;
  disposition: string | null;
  snapshot_date: string;
}

interface CitationRow {
  cluster_id: number | null;
  volume: number | null;
  reporter: string | null;
  page: string | null;
}

async function pg<T>(m: NonNullable<Mirror>, path: string): Promise<T[]> {
  const res = await pwFetch(`${m.url}/rest/v1/${path}`, {
    headers: { apikey: m.key, Authorization: `Bearer ${m.key}` },
  });
  if (!res.ok) return [];
  return (await res.json()) as T[];
}

/**
 * Page ownership is a windowed query over a volume, which PostgREST cannot
 * express as a filter — it goes through an RPC. A failure returns [] rather
 * than throwing, because a missing owner must fall through to the three-state
 * absence answer rather than error the whole lookup.
 */
async function rpc<T>(m: NonNullable<Mirror>, fn: string, args: Record<string, unknown>): Promise<T[]> {
  const res = await pwFetch(`${m.url}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: m.key, Authorization: `Bearer ${m.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!res.ok) return [];
  const body = (await res.json()) as T[] | T;
  return Array.isArray(body) ? body : [body];
}

function citeString(c: CitationRow): string {
  return [c.volume, c.reporter, c.page].filter(Boolean).join(' ');
}

/** "410 U.S. 113" / "347 US 483" into the three parts the index is keyed on. */
function parseCitation(raw: string): { volume: number; reporter: string; page: string } | null {
  const m = raw.trim().match(/^(\d+)\s+(.+?)\s+(\d+[A-Za-z]*)$/);
  if (!m) return null;
  return { volume: Number(m[1]), reporter: m[2].trim(), page: m[3] };
}

/**
 * Arkansas (and most other state supreme/appeals courts) switched to a
 * public-domain / neutral citation format — "YYYY <Reporter> N" — where the
 * volume is the FILING YEAR and the number after the reporter is the
 * SEQUENTIAL OPINION NUMBER for that year, not a page. parseCitation above
 * cannot tell the two formats apart; it only knows "digits, token, digits".
 *
 * page_range_ownership (citation_page_owner, migration 083) was built for
 * traditional bound reporters, where a citations-table row IS a page and the
 * gap between two rows IS the unprinted pages belonging to the earlier case.
 * Run against a neutral citation, the same SQL instead treats the PRECEDING
 * opinion number as a page and claims to "own" every number up to p_max_span
 * past it — so "2026 Ark. 140" (opinion 140, not yet in the mirror) silently
 * resolved to whichever earlier opinion happened to be numbered closest below
 * it (fleet #2923). No page-range inference is valid for these reporters at
 * all: an opinion number does not "span" a range the way a page range does,
 * so it is exact match or nothing.
 *
 * Confirmed LIVE against the mirror (2026-10-10), on the reporter TOKEN the
 * parser actually extracts — not the Bluebook spelling, which can differ
 * (checked rather than trusted, per fleet #2923):
 *   'Ark.'      — bug reproduces: 2026 Ark. 140 -> wrong case 2026 Ark. 114
 *   'Ark. App.' — token confirmed (2026 Ark. App. 60 parses reporter "Ark. App.")
 *   'UT'        — bug reproduces: 2026 UT 60 -> wrong case 2026 UT 33
 *   'WI'        — bug reproduces: 2026 WI 60 -> wrong case 2026 WI 32
 *   'CO'        — bug reproduces: 2026 CO 100 -> wrong case 2026 CO 65
 *   'VT'        — bug reproduces: 2026 VT 60 -> wrong case 2026 VT 41
 *   'OK','ND','SD','MT','WY','ME' — token confirmed via exact-match hits;
 *     same mechanism, not separately forced into the bug for these.
 * 'IL' and New Mexico/Ohio are NOT yet confirmed live and are included from
 * the pattern alone — New Mexico ("NMSC"/"NMCA") and Ohio ("Ohio") only
 * matter if a caller writes them with a space; their real citation form is
 * hyphenated ("2015-NMSC-10", "2015-Ohio-10"), which parseCitation already
 * rejects outright (no whitespace to match) before this function ever runs.
 *
 * The volume-is-a-year guard is defense in depth, not the primary signal:
 * every token below is also usable, unsuffixed, as a much OLDER bound
 * reporter in some jurisdictions (e.g. a 19th-century "5 Ohio 123"), and
 * those volumes never fall in a plausible filing-year range.
 */
const NEUTRAL_CITATION_REPORTERS = new Set([
  'Ark.', 'Ark. App.',
  'OK', 'ND', 'SD', 'MT', 'WY', 'ME', 'VT', 'UT', 'WI', 'CO', 'IL',
  'NMSC', 'NMCA', 'Ohio',
]);

export function isNeutralCitation(reporter: string, volume: number): boolean {
  if (!NEUTRAL_CITATION_REPORTERS.has(reporter)) return false;
  // The volume IS the filing year for these. +1 covers a case reported just
  // before the calendar turns; 1990 predates every one of these
  // jurisdictions' adoption of the format.
  const year = new Date().getUTCFullYear();
  return volume >= 1990 && volume <= year + 1;
}

async function citationsFor(m: NonNullable<Mirror>, clusterIds: number[]): Promise<Map<number, string[]>> {
  const byCluster = new Map<number, string[]>();
  if (!clusterIds.length) return byCluster;
  const cites = await pg<CitationRow & { cluster_id: number }>(
    m,
    `courtlistener_citations?cluster_id=in.(${clusterIds.join(',')})&select=cluster_id,volume,reporter,page&limit=200`,
  );
  for (const c of cites) {
    const list = byCluster.get(c.cluster_id) ?? [];
    list.push(citeString(c));
    byCluster.set(c.cluster_id, list);
  }
  return byCluster;
}

async function withCitations(m: NonNullable<Mirror>, clusters: ClusterRow[]) {
  if (!clusters.length) return [];
  const byCluster = await citationsFor(m, clusters.map((c) => c.id));
  return clusters.map((c) => ({
    cluster_id: c.id,
    case_name: c.case_name,
    case_name_full: c.case_name_full,
    date_filed: c.date_filed,
    judges: c.judges,
    precedential_status: c.precedential_status,
    // How often later courts cite it — the closest thing to "how important is
    // this case", and the reason results are ranked by it.
    citation_count: c.citation_count,
    citations: byCluster.get(c.id) ?? [],
    disposition: c.disposition,
    read_opinions_with: 'list_case_opinions({cluster_id}) for the opinion ids, then get_opinion({id})',
  }));
}

function mirrorUnavailable(tool: string) {
  return {
    found: false,
    reason: 'mirror_unavailable',
    message: `${tool} is not reachable from this deployment.`,
    hint: 'search_opinions queries CourtListener live.',
  };
}


/**
 * Case names are cited a dozen ways and the index only holds one of them.
 * `courtlistener_clusters.case_name` stores "Roe v. Wade", and the RPC behind
 * find_case matches on to_tsvector('english', case_name) — so the query has to
 * arrive in the vocabulary the index actually contains.
 *
 * "roe v wade" works because v is a token in both. "Roe versus Wade" returned
 * NOTHING, because `versus` appears nowhere in the corpus: english stemming does
 * not relate it to `v`, and there is no synonym dictionary configured. Same for
 * "vs" and "vs.". This is the tolerance the trigram index used to provide for
 * free, and it is what migration 063 was warning about when it chose trigram
 * over full-text for names in the first place.
 *
 * Fixing it here rather than in the index is deliberate: a second full-table
 * trigram index on 10M rows to catch one word is not worth the write cost and
 * the storage on a shared instance.
 */
export function normaliseCaseName(raw: string): string {
  return raw
    .replace(/[*,()"']/g, ' ')
    // versus / vs / vs. -> v, the form the corpus uses
    .replace(/\bversus\b/gi, 'v')
    .replace(/\bvs\.?(?=\s|$)/gi, 'v')
    // "v." tokenises the same as "v"; drop the period so both spellings agree
    .replace(/\bv\.(?=\s)/gi, 'v ')
    // "In re:" and "Ex parte" carry a colon that becomes a stray token
    .replace(/:/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Second-pass normalisation, applied only after the exact form has already
 * missed.
 *
 * search_case_names matches with `plainto_tsquery`, which is AND over every
 * token — so ONE token absent from the corpus returns zero rows for the whole
 * query, no matter how distinctive the rest of the name is. That is the entire
 * mechanism behind the miss rate on this tool, and it is ours, not the
 * caller's: the corpus holds "Bell Atlantic Corp. v. Twombly", the world cites
 * it as "Bell Atl. Corp. v. Twombly", and `atl` does not stem to `atlant`, so
 * Twombly — one of the most-cited cases in federal practice — returned nothing.
 * Measured against 48h of real traffic: 65% of all misses carried at least one
 * Bluebook abbreviation.
 *
 * Everything here DROPS tokens; nothing is expanded or substituted. That
 * direction is deliberate and it is what makes the pass safe. Under AND
 * semantics removing a token can only widen the result set, so a token we drop
 * can never cost us a case we would otherwise have found — whereas guessing an
 * expansion ("Atl." -> "Atlantic") would break every case where the corpus
 * itself stores the abbreviation. We do not need to know which spelling the
 * corpus used if we simply stop requiring that token at all; the distinctive
 * party names carry the match, and citation_count DESC does the ranking.
 *
 * Dropped, in order:
 *  - `.pdf` fragments and bare numbers — callers extracting names from briefs
 *    drag in page and footnote markers ("RF.pdf. 37 See United States v. Parks").
 *  - citation scaffold: "TABLE OF AUTHORITIES", "See", "supra", "quoting" —
 *    real English words, so they survive `normaliseCaseName` and then poison
 *    the AND. "TABLE OF AUTHORITIES Bowers v. Hardwick" returned zero while
 *    "Bowers v. Hardwick" returned the case.
 *  - contractions: Nat'l, Ass'n, Dep't, Comm'n. These need dropping as WHOLE
 *    tokens: stripping just the apostrophe leaves "Nat l", and `nat` is a live
 *    token that keeps the query dead.
 *  - any token ending in a period — the abbreviation case above.
 *  - corporate noise (Inc, Corp, Co, Ltd, Association…) and stray one-character
 *    leftovers such as a dangling "&".
 */
const CITE_SCAFFOLD =
  /\b(table of authorities|see also|see|cf|accord|quoting|citing|supra|infra)\b\.?/gi;
// Corporate suffixes (unstable spelling, near-zero selectivity) plus the
// English stopwords. The stopwords are listed for a narrower reason than the
// rest: plainto_tsquery('english', …) discards them anyway, so dropping them
// changes no result — it stops a string of pure scaffold ("See supra, at 12")
// from relaxing to a non-empty query like "at" that findCase would then treat
// as worth a second round-trip.
const ORG_NOISE = new Set([
  'inc', 'corp', 'corporation', 'co', 'company', 'ltd', 'limited', 'llc', 'lp',
  'llp', 'assn', 'association',
  'the', 'of', 'and', 'a', 'an', 'for', 'at', 'in', 'on', 'by', 'to', 'as',
  'or', 'with', 'from',
]);

export function relaxCaseName(raw: string): string {
  let s = raw
    // Whole filename token, not just from `.pdf` on — leaving the stem behind
    // turns "RF.pdf. 37 See United States v. Parks" into a query requiring `rf`,
    // which is exactly as dead as the original.
    .replace(/\S*\.pdf\S*/gi, ' ')
    .replace(CITE_SCAFFOLD, ' ')
    .replace(/\b\d+\b/g, ' ')
    // Contractions as whole tokens — see note above on why "Nat l" is worse
    // than dropping "Nat'l" outright. Covers both the straight and the curly
    // apostrophe, because text lifted out of a PDF carries the curly one.
    .replace(/[A-Za-z]+['\u2019\u02bc][a-z]{1,2}\b/g, ' ');
  s = normaliseCaseName(s);
  const kept: string[] = [];
  for (const t of s.split(' ')) {
    if (t.toLowerCase() === 'v') { kept.push('v'); continue; }
    if (t.endsWith('.')) continue;
    if (ORG_NOISE.has(t.toLowerCase())) continue;
    if (t.length < 2 || !/[A-Za-z]/.test(t)) continue;
    kept.push(t);
  }
  return kept.join(' ').trim();
}

/** The tokens either side of the `v` separator. No `v` means one side only. */
function captionSides(q: string): [string[], string[]] {
  const toks = q.split(' ').filter(Boolean);
  const i = toks.findIndex((t) => t.toLowerCase() === 'v');
  if (i === -1) return [toks, []];
  return [toks.slice(0, i), toks.slice(i + 1)];
}

/**
 * Whether the relaxed form is worth running — and, more to the point, whether
 * its rows can be trusted next to the exact ones. Two ways relaxation goes
 * wrong, both measured while fixing the Chevron miss (fleet #551):
 *
 *  1. It changes nothing that matters. "Brown v. Board of Education" relaxes to
 *     "Brown v Board Education": only `of` came out, and plainto_tsquery
 *     discards stopwords anyway, so the second query is the first query wearing
 *     a different spelling and costs a round-trip for an identical row set.
 *
 *  2. It erases a party. "Massachusetts v. E.P.A." relaxes to "Massachusetts v"
 *     — `E.P.A.` was the whole right-hand side. That query matches every case
 *     the Commonwealth has ever been party to, ranks them by citation count and
 *     returns Melendez-Diaz v. Massachusetts: a real case, a plausible number,
 *     and not the case anybody asked for. A caption with two sides has to still
 *     have two sides after relaxing; otherwise the relaxed form is not a wider
 *     search, it is a different question.
 */
export function relaxationIsUsable(cleaned: string, relaxed: string): boolean {
  if (!relaxed || relaxed === cleaned) return false;
  const kept = new Set(relaxed.toLowerCase().split(' '));
  const droppedMeaningful = cleaned.split(' ').some((t) => {
    if (kept.has(t.toLowerCase())) return false;
    const k = t.toLowerCase().replace(/\.+$/, '');
    if (!k || !/[a-z]/.test(k)) return false;   // "&", stray punctuation
    return !ORG_NOISE.has(k);                    // Corp./Inc./of/the change nothing
  });
  if (!droppedMeaningful) return false;
  const [exactLeft, exactRight] = captionSides(cleaned);
  const [relaxedLeft, relaxedRight] = captionSides(relaxed);
  if (exactLeft.length && exactRight.length &&
      (!relaxedLeft.length || !relaxedRight.length)) return false;
  return true;
}

async function findCase(m: Mirror, name: string, limit: number) {
  if (!m) return mirrorUnavailable('find_case');
  // RPC, not a PostgREST filter: the index is on
  // to_tsvector('english', coalesce(case_name,'')) and PostgREST's own fts
  // operator generates a different expression, which the planner will not
  // match — the query would quietly become a sequential scan over 10M rows on
  // the instance every other pack shares.
  const cleaned = normaliseCaseName(name);
  const relaxed = relaxCaseName(name);

  // This pass used to run ONLY when the exact form returned nothing, on the
  // reasoning that a hit needs no widening. A hit is not the same thing as the
  // right hit, and that is what the rule could not see. plainto_tsquery ANDs
  // every token, so one token the corpus spells differently EXCLUDES a case
  // rather than demoting it — and any other record that happens to spell it our
  // way survives to become the answer, which then suppresses the widening that
  // would have found the real one.
  //
  // Chevron is the worst version. The corpus files the 1984 merits decision as
  // "Chevron U. S. A. Inc. v. ..." with spaces, so `u.s.a` is not a token in it
  // and the query never reached cluster 111221 and its 20,645 citing opinions.
  // Two 1983 cert-stage orders spell it "U.S.A." unspaced, matched, and
  // answered "citation_count: 1" — a number a caller cannot sanity-check
  // without already knowing it, and one a lawyer could read as the case having
  // been abandoned. Erie R. Co. v. Tompkins failed the same way: 11 against a
  // true 18,491.
  //
  // So run both forms whenever relaxing actually drops something (see
  // relaxationIsUsable — clean names still cost exactly one query), merge, and
  // let citation_count rank the union the way search_case_names ranks each half.
  const useRelaxed = relaxationIsUsable(cleaned, relaxed);
  const [exact, wider] = await Promise.all([
    pg<ClusterRow>(m, `rpc/search_case_names?q=${encodeURIComponent(cleaned)}&lim=${limit}`),
    useRelaxed
      ? pg<ClusterRow>(m, `rpc/search_case_names?q=${encodeURIComponent(relaxed)}&lim=${limit}`)
      : Promise.resolve([] as ClusterRow[]),
  ]);

  const exactIds = new Set(exact.map((r) => r.id));
  const byId = new Map<number, ClusterRow>();
  for (const r of [...exact, ...wider]) if (!byId.has(r.id)) byId.set(r.id, r);
  const rows = [...byId.values()]
    .sort((a, b) => (b.citation_count ?? 0) - (a.citation_count ?? 0))
    .slice(0, limit);

  const matchedRelaxed = exact.length === 0 && rows.length > 0;
  // The exact form found something, but the answer improved once abbreviations
  // were dropped. Worth saying: it means the name as written does not match how
  // the corpus files this case, which is the caller's cue that the ids they are
  // about to store came from a looser match than they asked for.
  const supplemented = exact.length > 0 && rows.some((r) => !exactIds.has(r.id));
  return {
    query: name,
    returned: rows.length,
    cases: await withCitations(m, rows),
    source: 'court-listener',
    snapshot_date: rows[0]?.snapshot_date ?? null,
    // Say so when the match required dropping tokens. A widened match is a
    // best-effort resolution of an abbreviated or dirty citation, not a
    // verified identity, and a caller indexing at scale needs to be able to
    // tell the two apart rather than infer it from the name looking close.
    ...(matchedRelaxed
      ? {
          matched: 'relaxed',
          matched_query: relaxed,
          note:
            'The name as given matched nothing, so abbreviations and citation scaffold were dropped and the remaining distinctive terms were matched instead. Confirm the returned case_name is the case you meant.',
        }
      : {}),
    ...(supplemented
      ? {
          matched: 'widened',
          matched_query: relaxed,
          note:
            'The name as given did match, but the corpus files this case under a different spelling of one abbreviation, so the search was repeated with that token dropped and both result sets merged, ranked by citation count. The leading result here was NOT reachable from the name as written. Confirm the returned case_name is the case you meant.',
        }
      : {}),
    ...(rows.length === 0
      ? {
          found: false,
          hint:
            relaxed !== cleaned && !useRelaxed
              // Relaxing was rejected because the tokens it would drop are one
              // whole side of the caption — "Massachusetts v. E.P.A." leaves
              // "Massachusetts v", which matches every case the Commonwealth
              // was ever party to. Say what would actually work instead: the
              // corpus files that one as "Massachusetts v. Environmental
              // Protection Agency", spelled out.
              ? 'No case name matched. One party here is an abbreviation the corpus does not use, and it is the only term naming that side, so it cannot be dropped without changing the question. Spell the party out ("Massachusetts v. Environmental Protection Agency" rather than "Massachusetts v. E.P.A."), or use lookup_citation with the reporter cite. For a TOPIC rather than a name, use search_opinions.'
              : 'No case name matched. Names match as substrings, so try one distinctive party alone ("Sullivan" rather than "New York Times Co. v. Sullivan"). For a TOPIC rather than a name, use search_opinions, which searches full text upstream.',
        }
      : {}),
    attribution: 'CourtListener / Free Law Project — Public Domain Mark.',
  };
}

async function lookupCitation(m: Mirror, raw: string, arkD1?: unknown) {
  if (!m) return mirrorUnavailable('lookup_citation');
  const parsed = parseCitation(raw);
  if (!parsed) {
    return {
      found: false,
      reason: 'unparsed_citation',
      message: `"${raw}" is not a reporter citation. The expected shape is volume, reporter, page — for example "410 U.S. 113".`,
      hint: 'To find a case by name instead, use find_case({name: "Roe v. Wade"}).',
    };
  }
  const { volume, reporter, page } = parsed;
  const neutral = isNeutralCitation(reporter, volume);
  const cites = await pg<CitationRow>(
    m,
    `courtlistener_citations?volume=eq.${volume}&reporter=eq.${encodeURIComponent(reporter)}` +
      `&page=eq.${encodeURIComponent(page)}&select=cluster_id,volume,reporter,page&limit=5`,
  );
  let clusterIds = [...new Set(cites.map((c) => c.cluster_id).filter(Boolean))] as number[];
  let ownership: PageOwner[] = [];

  // An Arkansas neutral citation ("2026 Ark. 140", "2026 Ark. App. 449") names
  // an opinion by its number, not a page, and CourtListener runs months behind
  // the Arkansas courts. With no exact match, ask arkansas-opinions (read from
  // the courts' own archive) before the neutral-citation "opinion_not_held"
  // answer below (fleet #2923) is given (fleet #2924).
  if (!clusterIds.length) {
    const ark = await arkansasFallThrough(arkD1, raw);
    if (ark) return ark;
  }

  // Nothing STARTS on that page — but a citation usually points at a page
  // INSIDE an opinion. Measured on 51 unresolved eval citations, 18 failed for
  // this reason alone: "487 U.S. 166" while volume 487 sits in the table,
  // because the case begins at 164. Ask who owns the page before concluding
  // the citation is unresolvable.
  //
  // NEVER for a neutral citation (fleet #2923): the number after the
  // reporter is an opinion count, not a page, so no span of "owned" numbers
  // is valid — citation_page_owner would otherwise hand the nearest earlier
  // opinion number a confident, wrong answer ("2026 Ark. 140" -> "2026 Ark.
  // 114"). Exact match or nothing for these.
  if (!clusterIds.length && !neutral) {
    ownership = await pageOwners(m, reporter, volume, page);
    clusterIds = [...new Set(ownership.map((o) => o.cluster_id))];
  }

  if (!clusterIds.length && neutral) {
    const asOf = await mirrorSnapshotDate(m);
    return {
      found: false,
      reason: 'opinion_not_held',
      parsed,
      message: `We do not hold opinion ${page} of ${volume} ${reporter}; neutral citations are opinion numbers, not pages, so no page-range inference applies.`,
      hint: reporter.startsWith('Ark')
        ? `${reporter} is a public-domain/neutral citation format — the number after it is the opinion count for ${volume}, not a page, so no page-range fallback applies here. Absence here is a gap in our coverage, not evidence the opinion does not exist; for Arkansas opinions decided from 2026-01-01 on, arkansas-opinions (ark_opinion, ark_coverage) reads the courts' own archive hourly.`
        : `${reporter} is a public-domain/neutral citation format — the number after it is the opinion count for ${volume}, not a page, so no page-range fallback applies here. Absence here is a gap in our coverage, not evidence the opinion does not exist.`,
      snapshot_date: asOf,
    };
  }

  if (!clusterIds.length) {
    const span = await volumeSpan(m, reporter, volume);
    // Three states, because they are three different answers to "is this
    // citation real?" and collapsing them is how absence reads as fabrication.
    if (!span || !span.citations) {
      return {
        found: false,
        reason: 'volume_not_held',
        parsed,
        message: `We do not hold ${volume} ${reporter} at all, so this citation can be neither confirmed nor denied.`,
        hint: 'Absence here is a gap in our coverage, NOT evidence the case does not exist. Check the reporter abbreviation ("U.S." not "US", "F.3d" not "F3d"), then treat as unverified.',
      };
    }
    const numericPage = Number(page);
    if (Number.isFinite(numericPage) && numericPage > span.last_page_start) {
      return {
        found: false,
        reason: 'page_outside_covered_span',
        parsed,
        volume_span: { first_page: span.first_page, last_page_start: span.last_page_start, citations: span.citations },
        message: `We hold ${volume} ${reporter}, but our coverage of it starts at page ${span.first_page} and the last case we record begins at page ${span.last_page_start} — page ${page} is past that.`,
        hint: 'The volume is partially covered, so this is a gap in the volume rather than a missing case. Treat as unverified, not as fabricated.',
      };
    }
    return {
      found: false,
      reason: 'no_owning_case',
      parsed,
      volume_span: { first_page: span.first_page, last_page_start: span.last_page_start, citations: span.citations },
      message: `We hold ${volume} ${reporter} across pages ${span.first_page}-${span.last_page_start}, and no case we record owns page ${page}.`,
      hint: 'The volume is covered and the page falls inside it, so this is the strongest available signal that the citation is wrong — but it is still our record, not the reporter itself.',
    };
  }
  const clusters = await pg<ClusterRow>(
    m,
    `courtlistener_clusters?id=in.(${clusterIds.join(',')})&select=*`,
  );
  const byCluster = new Map(ownership.map((o) => [o.cluster_id, o]));
  const cases = (await withCitations(m, clusters)).map((c) => {
    const o = byCluster.get((c as { cluster_id?: number }).cluster_id ?? -1);
    return o ? { ...c, page_span: { first_page: o.start_page, last_page: o.end_page }, cited_page_is_start: o.exact_start } : c;
  });
  return {
    citation: raw,
    parsed,
    returned: clusters.length,
    // A pin cite resolved by ownership is a different claim from an exact hit,
    // and the caller is deciding whether a quote is real — say which it was.
    resolved_by: ownership.length ? 'page_range_ownership' : 'exact_citation',
    ...(ownership.length ? {
      pin_cite: true,
      pin_cite_note: `No case begins on page ${page} of ${volume} ${reporter}; ${clusters.length === 1 ? 'this case spans' : 'these cases span'} it. A pinpoint page inside an opinion resolves to the opinion that contains it.`,
      // The sharp edge, measured on the eval corpus: 13 citations adjudicated as
      // document ERRORS now resolve here. "Anderson v. Liberty Lobby, 447 U.S.
      // 242" is a typo for 477 U.S. 242, and page ownership returns whatever
      // genuinely occupies 447 U.S. 242 — a different case. That is the correct
      // answer to "what is printed there" and the wrong answer to "is this
      // citation right", so the two must not be confused.
      evidence_strength: 'weaker_than_exact',
      verification_warning: `This says what our record shows AT page ${page} of ${volume} ${reporter}. It does NOT confirm that the case you cited appears there. A transposed volume or page resolves to a real but unrelated case, so compare the returned case name against the one the citation claims before treating this as verified.`,
    } : {}),
    ...truncationCaution(reporter, page),
    cases,
    source: 'court-listener',
    snapshot_date: clusters[0]?.snapshot_date ?? null,
    attribution: 'CourtListener / Free Law Project — Public Domain Mark.',
  };
}

/**
 * arkansas-opinions' store, read directly (fleet #2924). The gateway hands this
 * pack the same D1 binding as `_d1` ("d1Binding": "ARK_OPINIONS_DB"). Read
 * inline rather than by importing @pipeworx/arkansas-opinions, because a
 * sibling-pack import makes court-listener a compound pack and drops it from
 * npm releases. Column names must match
 * workers/ark-opinions-collector/src/schema.ts; the fall-through test in
 * mcps/arkansas-opinions seeds the store through the collector's own code, so
 * a rename on either side reds there.
 */
interface ArkD1 {
  prepare(sql: string): { bind(...v: unknown[]): { first<T>(): Promise<T | null> } };
}
interface ArkRow {
  item_id: number; court: string; title: string; citation: string; decision_date: string | null;
  docket: string | null; author: string | null; disposition: string | null; citation_status: string | null;
  citation_status_note: string | null; source_url: string; text: string | null;
  data_as_of: string | null;
}

function parseArkNeutral(raw: string): { year: number; reporter: 'Ark.' | 'Ark. App.'; number: number; citation: string } | null {
  const m = /^\s*((?:19|20)\d{2})\s+Ark\.?\s*(App\.?)?\s+(\d{1,4})\s*$/i.exec(raw);
  if (!m) return null;
  const reporter = m[2] ? 'Ark. App.' : 'Ark.';
  return { year: Number(m[1]), reporter, number: Number(m[3]), citation: `${m[1]} ${reporter} ${Number(m[3])}` };
}

async function arkansasFallThrough(arkD1: unknown, raw: string) {
  const c = parseArkNeutral(raw);
  // Neutral citations began in 2009; "171 Ark. 140" is a reporter volume.
  if (!c || c.year < 2009 || !arkD1 || typeof (arkD1 as ArkD1).prepare !== 'function') return null;
  let row: ArkRow | null = null;
  try {
    row = await (arkD1 as ArkD1)
      .prepare(
        `SELECT o.item_id, o.court, o.title, o.citation, o.decision_date, o.docket, o.author, o.disposition,
           o.citation_status, o.citation_status_note, o.source_url,
           substr(v.text, 1, 3000) AS text,
           (SELECT max(finished_at) FROM collector_runs WHERE ok = 1) AS data_as_of
         FROM opinions o LEFT JOIN opinion_versions v ON v.item_id = o.item_id AND v.is_current = 1
         WHERE o.cite_year = ? AND o.cite_reporter = ? AND o.cite_number = ?
         ORDER BY (o.doc_kind = 'opinion') DESC, o.item_id LIMIT 1`,
      )
      .bind(c.year, c.reporter, c.number)
      .first<ArkRow>();
  } catch {
    // The arkansas-opinions store is unreachable: answer from CourtListener
    // alone, exactly as before this fall-through existed.
    return null;
  }
  if (!row) return null;
  return {
    citation: raw,
    parsed: { volume: c.year, reporter: c.reporter, page: String(c.number) },
    returned: 1,
    resolved_by: 'arkansas_opinions_neutral_citation',
    note: `CourtListener has no case at ${c.citation}. The Arkansas courts' own opinion archive does; this answer comes from the arkansas-opinions pack, which reads it hourly. Call ark_opinion for the full text and version history.`,
    cases: [{
      case_name: row.title,
      court: row.court === 'supreme' ? 'Arkansas Supreme Court' : 'Arkansas Court of Appeals',
      date_filed: row.decision_date,
      docket_number: row.docket,
      citations: [c.citation],
      author: row.author,
      disposition: row.disposition,
      citation_status: row.citation_status ?? 'not_yet_read',
      citation_status_note: row.citation_status_note ?? 'The court has listed this opinion and its text has not been read yet; do not treat it as citable until it is.',
      excerpt: row.text,
      source_url: row.source_url,
    }],
    source: 'arkansas-opinions',
    data_as_of: row.data_as_of,
    attribution: 'Arkansas Judiciary, official opinions archive.',
  };
}

interface PageOwner { cluster_id: number; start_page: number; end_page: number; exact_start: boolean }

async function pageOwners(m: NonNullable<Mirror>, reporter: string, volume: string | number, page: string): Promise<PageOwner[]> {
  const n = Number(page);
  if (!Number.isFinite(n)) return [];
  return rpc<PageOwner>(m, 'citation_page_owner', {
    p_reporter: reporter, p_volume: Number(volume), p_page: n,
  }).catch(() => []);
}

async function volumeSpan(m: NonNullable<Mirror>, reporter: string, volume: string | number) {
  const rows = await rpc<{ citations: number; first_page: number; last_page_start: number }>(
    m, 'citation_volume_span', { p_reporter: reporter, p_volume: Number(volume) },
  ).catch(() => []);
  return rows[0] ?? null;
}

/**
 * "868 F. Supp. 2" is not a citation to page 2 — it is "868 F. Supp. 2d ___"
 * with the page lost. Two of these sat in the eval corpus, and page-range
 * ownership resolved both to the case starting at page 1, which is a confident
 * wrong answer where a refusal belongs. Flag the shape; do not silently drop it.
 */
const SERIES_SUFFIX = new Set(['2', '3', '4']);
function truncationCaution(reporter: string, page: string) {
  if (!SERIES_SUFFIX.has(page.trim())) return {};
  return {
    truncation_caution: `The citation ends "${reporter} ${page}", and ${page} is also how a reporter series is written ("${reporter} ${page}d"). If the source text was cut off, the real citation is "${reporter} ${page}d" plus a page, and this match is to the wrong reporter entirely. Confirm the series before relying on it.`,
  };
}

async function listCaseOpinions(m: Mirror, clusterId: number) {
  if (!m) return mirrorUnavailable('list_case_opinions');
  const rows = await pg<{
    id: number;
    type: string | null;
    author_str: string | null;
    extracted_by_ocr: boolean;
    text_bytes: number | null;
  }>(
    m,
    `courtlistener_opinions?cluster_id=eq.${clusterId}` +
      `&select=id,type,author_str,extracted_by_ocr,text_bytes&limit=50`,
  );
  return {
    cluster_id: clusterId,
    returned: rows.length,
    // A case can carry a majority, a concurrence and a dissent as separate
    // opinions. Returning them all is the difference between reading the
    // holding and reading a fragment of it.
    opinions: rows.map((r) => ({
      opinion_id: r.id,
      type: r.type,
      author: r.author_str,
      extracted_by_ocr: r.extracted_by_ocr,
      text_bytes: r.text_bytes,
      read_with: `get_opinion({id: ${r.id}})`,
    })),
    ...(rows.length === 0
      ? { found: false, hint: 'No opinions found for that cluster; the case may postdate the covered window.' }
      : {}),
    source: 'court-listener',
  };
}

// ── Corpus access ─────────────────────────────────────────────────────
//
// The upstream REST API allows 125 requests per DAY and 401s on every detail
// endpoint without a token — get_opinion recorded 0 successes in 30 days
// because of it. These paths are not subject to that limit; a single lookup
// returns an opinion's metadata and its text together.
//
// The corpus carries an as-of date. Anything filed after it is genuinely
// absent and falls through to the upstream API.

type Mirror = { url: string; key: string; r2: R2Bucketish } | null;

interface R2Bucketish {
  get(key: string, opts?: { range?: { offset: number; length: number } }):
    Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
}

interface MirrorRow {
  id: number;
  cluster_id: number | null;
  author_str: string | null;
  type: string | null;
  date_created: string | null;
  download_url: string | null;
  extracted_by_ocr: boolean;
  source_column: string | null;
  pack_no: number;
  byte_offset: number;
  byte_length: number;
  snapshot_date: string;
}

function mirrorFromArgs(args: Record<string, unknown>): Mirror {
  const url = (args._supabaseUrl as string | undefined)?.trim();
  const key = (args._supabaseKey as string | undefined)?.trim();
  const r2 = args._r2 as R2Bucketish | undefined;
  return url && key && r2 ? { url, key, r2 } : null;
}

async function mirrorRow(m: NonNullable<Mirror>, id: number): Promise<MirrorRow | null> {
  const res = await pwFetch(
    `${m.url}/rest/v1/courtlistener_opinions?id=eq.${id}&select=*&limit=1`,
    { headers: { apikey: m.key, Authorization: `Bearer ${m.key}` } },
  );
  if (!res.ok) return null;
  const rows = (await res.json()) as MirrorRow[];
  return rows[0] ?? null;
}

async function mirrorText(
  m: NonNullable<Mirror>,
  row: Pick<MirrorRow, 'pack_no' | 'byte_offset' | 'byte_length' | 'snapshot_date'>,
): Promise<string | null> {
  const key = `courtlistener/${row.snapshot_date}/pack-${String(row.pack_no).padStart(4, '0')}.bin`;
  const obj = await m.r2.get(key, { range: { offset: row.byte_offset, length: row.byte_length } });
  if (!obj) return null;
  const gz = await obj.arrayBuffer();
  const stream = new Response(gz).body?.pipeThrough(new DecompressionStream('gzip'));
  if (!stream) return null;
  return await new Response(stream).text();
}

async function getOpinion(id: number, args: Record<string, unknown> = {}) {
  const m = mirrorFromArgs(args);
  if (m) {
    const row = await mirrorRow(m, id);
    if (row) {
      // Cluster and text in parallel: the cluster lookup is a single indexed
      // row and should not add a round trip to reading an opinion.
      const [text, clusters] = await Promise.all([
        mirrorText(m, row),
        row.cluster_id
          ? pg<ClusterRow>(m, `courtlistener_clusters?id=eq.${row.cluster_id}&select=*&limit=1`)
          : Promise.resolve([] as ClusterRow[]),
      ]);
      const cluster = clusters[0];
      if (text) {
        return {
          id: row.id,
          cluster_id: row.cluster_id,
          author: row.author_str || null,
          type: row.type || null,
          // date_created is when the record entered CourtListener's database —
          // a 1946 opinion reads 2020. The real ruling date and the case name
          // live on the cluster, so they are joined in rather than left for the
          // caller to fetch separately and probably not bother.
          date_created: row.date_created || null,
          case_name: cluster?.case_name ?? null,
          case_name_full: cluster?.case_name_full ?? null,
          date_filed: cluster?.date_filed ?? null,
          citation_count: cluster?.citation_count ?? null,
          precedential_status: cluster?.precedential_status ?? null,
          download_url: row.download_url || null,
          url: `https://www.courtlistener.com/opinion/${row.cluster_id ?? row.id}/`,
          text,
          text_chars: text.length,
          // Told, not buried: 14.2% of the corpus is OCR of old scans and reads
          // accordingly. A caller quoting it deserves to know before it looks
          // like our transcription error.
          extracted_by_ocr: row.extracted_by_ocr,
          rendition: row.source_column,
          source: 'court-listener',
          snapshot_date: row.snapshot_date,
          attribution: 'CourtListener / Free Law Project — Public Domain Mark.',
        };
      }
    }
  }

  const res = await pwFetch(`${BASE}/opinions/${id}/`, {
    headers: { Accept: 'application/json' },
  });
  // A 401 here is NOT "not found" — CourtListener gates every detail endpoint
  // behind a token while leaving /search/ open, so reporting it as a missing
  // opinion sends the caller hunting for a bad ID that is actually correct.
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `CourtListener requires an API token for full opinion text (HTTP ${res.status}). Opinion ${id} may well exist — this is an auth limit, not a missing record. Search results (search_opinions / search_dockets) remain available without a token, and each carries a url you can read directly. A free token is available from Free Law Project at https://www.courtlistener.com/help/api/rest/.`,
    );
  }
  if (res.status === 404) throw new Error(`CourtListener: opinion ${id} not found.`);
  if (!res.ok) throw new Error(`CourtListener API error (${res.status}) fetching opinion ${id}.`);

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

// ── RECAP filings (PACER documents) ──────────────────────────────────
//
// The obvious endpoints — /recap-documents/ and /docket-entries/ — both answer
// "Authentication credentials were not provided", so they are NOT the keyless
// path (probed 2026-08-10). /search/?type=rd is: it returns RECAP documents as
// flat top-level rows and needs no token.
//
// Scoping MUST go through `q`, not a query parameter. `?docket_id=71886217`
// is silently IGNORED — it returned the entire 61.7M-document corpus rather
// than an error, so a tool built on it would hand back arbitrary filings
// labelled as the requested docket. `q=docket_id:71886217` correctly returns 1
// docket / 18 documents.
const STORAGE = 'https://storage.courtlistener.com';

interface RecapRow {
  id?: number;
  docket_id?: number;
  docket_entry_id?: number;
  document_number?: number | string | null;
  attachment_number?: number | null;
  entry_number?: number | null;
  entry_date_filed?: string | null;
  description?: string | null;
  short_description?: string | null;
  document_type?: string | null;
  page_count?: number | null;
  is_available?: boolean | null;
  filepath_local?: string | null;
  absolute_url?: string | null;
  snippet?: string | null;
}

function projectFiling(r: RecapRow) {
  return {
    document_id: r.id ?? null,
    docket_id: r.docket_id ?? null,
    docket_entry_id: r.docket_entry_id ?? null,
    entry_number: r.entry_number ?? null,
    document_number: r.document_number ?? null,
    attachment_number: r.attachment_number ?? null,
    date_filed: r.entry_date_filed ?? null,
    description: r.description ?? null,
    short_description: r.short_description ?? null,
    document_type: r.document_type ?? null,
    page_count: r.page_count ?? null,
    // RECAP holds docket TEXT for far more filings than it holds documents: a
    // PDF only exists once somebody has paid PACER for it. Saying so per-filing
    // is what stops "no pdf_url" from being read as "no such filing".
    pdf_available: r.is_available === true,
    pdf_url: r.filepath_local ? `${STORAGE}/${r.filepath_local}` : null,
    text_excerpt: r.snippet || null,
    url: clUrl(r.absolute_url),
  };
}

// type=rd rows carry NO parent-docket fields — caseName/court/docketNumber exist
// only on the docket-grouped type=r shape, and returning them here would put a
// null case name on every filing. Rather than spend a second request per call
// against a ~125/day budget re-fetching what search_dockets already handed the
// caller, the filing carries docket_id so the case can be named from there.

/**
 * Every RECAP call goes upstream to CourtListener's /search/, which is throttled
 * to ~125 requests/day for a token-less caller — the throttle the opinion mirror
 * exists to avoid. There is no mirror for RECAP, so say plainly when we've been
 * refused rather than reporting it as an empty docket.
 */
async function recapSearch(q: string, limit: number, extra?: Record<string, string>) {
  const params = new URLSearchParams({ type: 'rd', q, ...extra });
  try {
    return await searchPaged(params, limit);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/\b429\b|throttl/i.test(msg)) {
      throw new Error(
        'CourtListener refused this request: its filing search is throttled to about 125 requests a day for callers without a token, and that budget is currently spent. This is an upstream rate limit, not an empty docket — the filings still exist. Court OPINIONS are unaffected: search_case_law, find_case and get_opinion are not subject to that limit.',
      );
    }
    throw err;
  }
}

async function listDocketFilings(docketId: number, limit: number) {
  if (!Number.isFinite(docketId)) throw new Error('docket_id must be a number');
  const { rows, total, truncated } = await recapSearch(
    `docket_id:${docketId}`, limit, { order_by: 'entry_date_filed asc' },
  );
  const filings = (rows as RecapRow[]).map(projectFiling);
  if (!filings.length) {
    return {
      found: false,
      reason: 'no_filings_indexed',
      docket_id: docketId,
      hint: 'RECAP has no filings indexed for this docket id. Confirm the id came from search_dockets (it is the docket_id field, not the PACER case id), and note RECAP only holds dockets somebody has fetched from PACER — a real federal case can be absent entirely.',
    };
  }
  return {
    found: true,
    docket_id: docketId,
    total_filings: total,
    returned: filings.length,
    truncated,
    pdfs_available: filings.filter((f) => f.pdf_available).length,
    filings,
  };
}

async function getDocketFiling(documentId: number) {
  if (!Number.isFinite(documentId)) throw new Error('document_id must be a number');
  const { rows } = await recapSearch(`id:${documentId}`, 1);
  const row = (rows as RecapRow[])[0];
  if (!row) {
    return {
      found: false,
      reason: 'document_not_found',
      document_id: documentId,
      hint: 'No RECAP document carries this id. The id must come from list_docket_filings or search_court_filings — a docket id or a PACER document number will not resolve here.',
    };
  }
  return { found: true, ...projectFiling(row) };
}

async function searchCourtFilings(query: string, court: string | undefined, limit: number) {
  if (!query || !query.trim()) throw new Error('query is required');
  const q = court ? `${query} AND court_id:${court.trim()}` : query;
  const { rows, total, truncated } = await recapSearch(q, limit);
  const filings = (rows as RecapRow[]).map(projectFiling);
  return {
    found: filings.length > 0,
    query,
    court: court ?? null,
    total_matches: total,
    returned: filings.length,
    truncated,
    filings,
    ...(filings.length ? {} : {
      reason: 'no_matches',
      hint: 'No RECAP filing text matched. RECAP covers documents fetched from PACER, not every federal filing, and matching is on the filing text and the clerk\'s docket description. Try fewer or unquoted terms, drop the court filter, or search appellate rulings instead with search_case_law.',
    }),
  };
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
