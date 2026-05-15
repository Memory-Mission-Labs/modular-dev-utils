/**
 * Provider-agnostic citation verification core.
 *
 * This module intentionally avoids Lovable-specific APIs and TanStack server
 * functions. It can run in any TypeScript server/runtime that provides `fetch`,
 * or you can inject a custom fetch implementation through CitationOptions.
 *
 * To use an LLM, pass a CitationModelProvider. The provider can wrap OpenAI,
 * Anthropic, Gemini, a local model, or any other backend. This file only owns
 * input validation, source fetching, anti-hallucination QA, evidence extraction,
 * URL fallback, and verification-state classification.
 */

export interface CitationInput {
  source: string;
  sourceUrl?: string;
  topic: string;
}

export type VerificationState =
  | "VERIFIED_QUOTE"
  | "VERIFIED_PARAPHRASE"
  | "ABSTRACT_LIMITED"
  | "PLAUSIBLE_UNVERIFIED"
  | "UNSUPPORTED";

export interface CitationResult {
  quote: string;
  attribution: string;
  context?: string;
  verbatim: boolean;
  paraphrased: boolean;
  sourceUrl?: string;
  fetched: boolean;
  /** Epistemic verification class — primary signal for the UI. */
  verification: VerificationState;
  /** Short OCR/text-extracted passage from the live source, when available. */
  evidence?: string;
}

export type SourceMode = "RESTRICTED" | "OPEN_ACCESS" | "UNKNOWN";

export interface CitationModelRequest {
  source: string;
  sourceUrl?: string;
  topic: string;
  sourceMode: SourceMode;
  scrapedSourceText?: string;
  systemPrompt: string;
  userPrompt: string;
}

export interface CitationModelResponse {
  quote?: string;
  attribution?: string;
  context?: string;
  verbatim?: boolean;
  paraphrased?: boolean;
}

export interface CitationModelProvider {
  generateCitationEvidence(request: CitationModelRequest): Promise<CitationModelResponse>;
}

export interface CitationOptions {
  /** Required for AI-assisted passage selection/paraphrase generation. */
  provider: CitationModelProvider;
  /** Optional fetch implementation for tests, serverless runtimes, or Node polyfills. */
  fetchFn?: typeof fetch;
  /** Maximum fetched source characters passed into the provider. Default: 18,000. */
  maxSourceChars?: number;
  /** Disable the final link health probe when running in restricted/browser contexts. */
  skipLinkProbe?: boolean;
  /**
   * Allow fetching URLs that fail the default backend safety checks.
   * Keep false for user-submitted URLs in server runtimes.
   */
  allowUnsafeSourceUrls?: boolean;
  /** Optional URL allow-list. Supports exact host matches and subdomains. */
  allowedHosts?: string[];
  /** Optional URL block-list. Supports exact host matches and subdomains. */
  blockedHosts?: string[];
  /** Optional headers for source fetching and link probing. */
  requestHeaders?: Record<string, string>;
}

function isCitationInput(input: unknown): input is CitationInput {
  if (!input || typeof input !== "object") return false;
  const i = input as Record<string, unknown>;
  return typeof i.source === "string" && typeof i.topic === "string";
}

function sanitizeInput(input: CitationInput): CitationInput {
  return {
    source: input.source.slice(0, 400),
    sourceUrl: typeof input.sourceUrl === "string" ? input.sourceUrl.slice(0, 500) : undefined,
    topic: input.topic.slice(0, 1200),
  };
}

export function assertCitationInput(input: unknown): CitationInput {
  if (!isCitationInput(input)) {
    throw new Error("Invalid input: source and topic strings required");
  }
  return sanitizeInput(input);
}

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

const DEFAULT_REQUEST_HEADERS: Record<string, string> = {
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

export interface SourceUrlPolicy {
  allowUnsafeSourceUrls?: boolean;
  allowedHosts?: string[];
  blockedHosts?: string[];
}

export interface SourceUrlValidation {
  ok: boolean;
  url?: URL;
  reason?: string;
}

function hostMatches(host: string, candidates: string[] | undefined): boolean {
  if (!candidates || candidates.length === 0) return false;
  const normalizedHost = host.toLowerCase();
  return candidates.some((candidate) => {
    const c = candidate.trim().toLowerCase();
    return c.length > 0 && (normalizedHost === c || normalizedHost.endsWith("." + c));
  });
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = parts;
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  const isIpv6Literal = host.includes(":") || (host.startsWith("[") && host.endsWith("]"));
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    host === "[::1]" ||
    host === "0:0:0:0:0:0:0:1" ||
    (isIpv6Literal && (host.startsWith("fc") || host.startsWith("[fc"))) ||
    (isIpv6Literal && (host.startsWith("fd") || host.startsWith("[fd"))) ||
    (isIpv6Literal && (host.startsWith("fe80") || host.startsWith("[fe80"))) ||
    isPrivateIpv4(host)
  );
}

export function validateSourceUrl(sourceUrl: string | undefined, policy: SourceUrlPolicy = {}): SourceUrlValidation {
  if (!sourceUrl) return { ok: false, reason: "No source URL provided." };

  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    return { ok: false, reason: "Source URL is not a valid absolute URL." };
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, reason: "Source URL must use http or https." };
  }

  if (url.username || url.password) {
    return { ok: false, reason: "Source URL must not include credentials." };
  }

  const host = url.hostname.toLowerCase();
  if (hostMatches(host, policy.blockedHosts)) {
    return { ok: false, reason: "Source URL host is blocked by policy." };
  }

  if (policy.allowedHosts?.length && !hostMatches(host, policy.allowedHosts)) {
    return { ok: false, reason: "Source URL host is not allowed by policy." };
  }

  if (!policy.allowUnsafeSourceUrls && isBlockedHostname(host)) {
    return { ok: false, reason: "Source URL points to a private or local network host." };
  }

  return { ok: true, url };
}

async function tryFetchSource(
  url: string,
  fetchFn: typeof fetch,
  maxSourceChars: number,
  requestHeaders: Record<string, string>,
): Promise<string | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetchFn(url, {
      signal: ctrl.signal,
      headers: requestHeaders,
      redirect: "follow",
    });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    const body = await res.text();
    const text = ct.includes("html") || /<html|<body|<p|<div/i.test(body)
      ? htmlToText(body)
      : body.replace(/\s+/g, " ").trim();
    return text.slice(0, maxSourceChars);
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function probeUrl(url: string, fetchFn: typeof fetch, requestHeaders: Record<string, string>): Promise<boolean> {
  const attempt = async (method: "HEAD" | "GET") => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    try {
      const res = await fetchFn(url, {
        method,
        signal: ctrl.signal,
        headers: requestHeaders,
        redirect: "follow",
      });
      return res.status < 400;
    } catch {
      return false;
    } finally {
      clearTimeout(t);
    }
  };
  if (await attempt("HEAD")) return true;
  return attempt("GET");
}

function fallbackUrl(originalUrl: string | undefined, source: string): string {
  if (originalUrl) {
    const pmid = originalUrl.match(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/i)?.[1]
      ?? originalUrl.match(/\/pmc\/articles\/PMC(\d+)/i)?.[1];
    if (pmid && /pubmed/i.test(originalUrl)) {
      return `https://europepmc.org/abstract/MED/${pmid}`;
    }
    const doi = originalUrl.match(/10\.\d{4,9}\/[^\s"<>)]+/)?.[0];
    if (doi) return `https://doi.org/${doi}`;
  }
  const q = encodeURIComponent(source.slice(0, 200));
  return `https://scholar.google.com/scholar?q=${q}`;
}

function classifySource(sourceUrl?: string): { host: string; isRestricted: boolean; isOpen: boolean; sourceMode: SourceMode } {
  const host = (() => {
    try { return new URL(sourceUrl ?? "").hostname.toLowerCase(); } catch { return ""; }
  })();

  const restrictedHosts = [
    "thelancet.com", "lancet.com", "nejm.org", "sciencedirect.com", "elsevier.com",
    "springer.com", "link.springer.com", "nature.com", "wiley.com", "onlinelibrary.wiley.com",
    "jamanetwork.com", "cell.com", "academic.oup.com", "tandfonline.com", "sagepub.com",
    "journals.lww.com", "bmj.com", "ahajournals.org", "pnas.org", "science.org",
  ];
  const openHosts = [
    "wikipedia.org", "wikimedia.org", "wikisource.org", "en.wikisource.org",
    "archive.org", "gutenberg.org", "plato.stanford.edu", "iep.utm.edu",
    "ncbi.nlm.nih.gov", "pubmed.ncbi.nlm.nih.gov", "pmc.ncbi.nlm.nih.gov",
    "who.int", "cdc.gov", "nih.gov",
  ];

  const isRestricted = restrictedHosts.some(h => host === h || host.endsWith("." + h));
  const isOpen = !isRestricted && (host.endsWith(".edu") || openHosts.some(h => host === h || host.endsWith("." + h)));
  const sourceMode: SourceMode = isRestricted ? "RESTRICTED" : isOpen ? "OPEN_ACCESS" : "UNKNOWN";

  return { host, isRestricted, isOpen, sourceMode };
}

function buildCitationPrompts(data: CitationInput, sourceMode: SourceMode, scraped: string | null, fetched: boolean) {
  const systemPrompt =
    "You are a careful intellectual historian and reference librarian. Your job is to surface ONE short passage (1–3 sentences, or a single statistic with its surrounding clause) that supports the given topic, drawn from the named source. " +
    "SOURCE_MODE controls behavior: " +
    "• RESTRICTED (peer-reviewed/paywalled journal — Lancet, NEJM, Elsevier, Wiley, Nature, JAMA, etc.): NEVER claim a verbatim quote. Always return a careful paraphrase (verbatim=false, paraphrased=true) summarizing the most likely figure/claim, and in 'context' state that the source is paywalled and the wording must be verified against the original PDF/article via the provided link. " +
    "• OPEN_ACCESS (Wikipedia, Wikimedia, archive.org, Project Gutenberg, .edu, SEP/IEP, WHO, NIH/PMC, etc.): If SCRAPED_SOURCE_TEXT contains a passage that supports the topic, return it WORD-FOR-WORD verbatim from that text — preserve original punctuation, casing, numbers, and spelling exactly (verbatim=true, paraphrased=false). If SCRAPED_SOURCE_TEXT is present but no supporting passage exists, return a paraphrase summarizing the closest relevant material (verbatim=false, paraphrased=true) with a verify-via-link note in 'context'. " +
    "• UNKNOWN: If SCRAPED_SOURCE_TEXT is provided and clearly contains the supporting passage, you may return it verbatim; otherwise paraphrase with a disclaimer. " +
    "If you cannot reasonably support the topic from the source at all, return quote='', verbatim=false, paraphrased=false, and explain in 'context'. NEVER fabricate a quote or attribute words to the source that do not appear there. Output STRICT JSON or an equivalent object: {\"quote\": string, \"attribution\": string, \"context\": string, \"verbatim\": boolean, \"paraphrased\": boolean}. 'attribution' must include author/work and a locator (page/section/§/paragraph) when known.";

  const userPrompt = [
    `Source: ${data.source}`,
    data.sourceUrl ? `URL: ${data.sourceUrl}` : "",
    `SOURCE_MODE: ${sourceMode}`,
    "",
    "Topic / pop-up content the quote should support:",
    data.topic,
    "",
    sourceMode === "RESTRICTED"
      ? "SCRAPED_SOURCE_TEXT: (skipped — restricted/paywalled journal; do NOT claim a verbatim quote, paraphrase only)"
      : fetched
        ? `SCRAPED_SOURCE_TEXT (live fetch from URL, may be truncated):\n${scraped}`
        : data.sourceUrl
          ? "SCRAPED_SOURCE_TEXT: (fetch failed or returned no usable text — paraphrase with disclaimer)"
          : "SCRAPED_SOURCE_TEXT: (none — no URL provided; paraphrase with disclaimer unless certain of verbatim wording)",
    "",
    "Return JSON/object only.",
  ].join("\n");

  return { systemPrompt, userPrompt };
}

function norm(s: string) {
  return s
    .toLowerCase()
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
    .replace(/[\u2013\u2014\u2212]/g, "-")
    .replace(/[^\w\s'".,%-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Main portable citation generator.
 *
 * Example:
 *   const result = await generateCitation(input, {
 *     provider: myOpenAIProvider,
 *   });
 */
export async function generateCitation(
  input: CitationInput,
  options: CitationOptions,
): Promise<CitationResult> {
  const data = assertCitationInput(input);
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  if (!fetchFn) throw new Error("No fetch implementation available. Provide options.fetchFn.");

  const maxSourceChars = options.maxSourceChars ?? 18000;
  const requestHeaders = { ...DEFAULT_REQUEST_HEADERS, ...options.requestHeaders };
  const { isRestricted, sourceMode } = classifySource(data.sourceUrl);
  const sourceUrlValidation = validateSourceUrl(data.sourceUrl, {
    allowUnsafeSourceUrls: options.allowUnsafeSourceUrls,
    allowedHosts: options.allowedHosts,
    blockedHosts: options.blockedHosts,
  });
  const safeSourceUrl = sourceUrlValidation.ok ? sourceUrlValidation.url!.toString() : undefined;
  const urlSafetyNote = data.sourceUrl && !sourceUrlValidation.ok
    ? `Source URL was not fetched or probed: ${sourceUrlValidation.reason}`
    : undefined;

  const scraped = safeSourceUrl && !isRestricted
    ? await tryFetchSource(safeSourceUrl, fetchFn, maxSourceChars, requestHeaders)
    : null;
  const fetched = scraped !== null && scraped.length > 50;

  const { systemPrompt, userPrompt } = buildCitationPrompts(data, sourceMode, scraped, fetched);
  const parsed = await options.provider.generateCitationEvidence({
    source: data.source,
    sourceUrl: data.sourceUrl,
    topic: data.topic,
    sourceMode,
    scrapedSourceText: sourceMode === "RESTRICTED" ? undefined : scraped ?? undefined,
    systemPrompt,
    userPrompt,
  });

  const rawQuote = (parsed.quote ?? "").toString().trim();
  const modelVerbatim = parsed.verbatim === true;
  const modelParaphrased = parsed.paraphrased === true;

  let verbatim = modelVerbatim && !isRestricted;
  let paraphrased = !verbatim && (modelParaphrased || isRestricted);
  let qaNote: string | undefined;

  if (verbatim) {
    const haystack = scraped ? norm(scraped) : "";
    const needle = norm(rawQuote);
    const minLen = 24;
    const matches = needle.length >= minLen && haystack.includes(needle);
    if (!matches) {
      verbatim = false;
      paraphrased = true;
      qaNote =
        "Verbatim match could not be confirmed against the live source text. Shown as paraphrase — verify wording against the original.";
    }
  }

  if (paraphrased && scraped && rawQuote) {
    const numbers = rawQuote.match(/\d[\d.,]*\s?%?/g) ?? [];
    const meaningful = numbers.filter((n) => n.replace(/[^\d]/g, "").length >= 2);
    if (meaningful.length > 0) {
      const hay = norm(scraped);
      const anyHit = meaningful.some((n) => hay.includes(norm(n)));
      if (!anyHit) {
        qaNote =
          "None of the figures in this paraphrase were found in the live source text — treat as unverified and check the original.";
      }
    }
  }

  const finalQuote = verbatim || paraphrased ? rawQuote : "";
  const tooShort = finalQuote.length > 0 && finalQuote.length < 8;
  if (tooShort) {
    verbatim = false;
    paraphrased = false;
  }

  const baseContext = parsed.context ? parsed.context.toString().trim() : "";
  const fallbackContext = verbatim
    ? undefined
    : paraphrased
      ? isRestricted
        ? "Full text inaccessible — verification limited to abstract/metadata. Verify exact wording against the original article."
        : "AI paraphrase — verify the figure or claim against the linked source."
      : "No supporting passage could be confirmed in the named source.";
  const mergedContext = [urlSafetyNote, qaNote, baseContext || fallbackContext]
    .filter(Boolean)
    .join(" ")
    .trim();

  let evidence: string | undefined;
  if (scraped && rawQuote) {
    const sentences = scraped.split(/(?<=[.!?])\s+/);
    if (verbatim) {
      const needle = norm(rawQuote);
      const hit = sentences.find((s) => norm(s).includes(needle));
      evidence = (hit ?? rawQuote).slice(0, 360).trim();
    } else if (paraphrased) {
      const numbers = (rawQuote.match(/\d[\d.,]*\s?%?/g) ?? []).filter(
        (n) => n.replace(/[^\d]/g, "").length >= 2,
      );
      if (numbers.length > 0) {
        const hay = norm(scraped);
        const matched = numbers.find((n) => hay.includes(norm(n)));
        if (matched) {
          const hit = sentences.find((s) => norm(s).includes(norm(matched)));
          if (hit) evidence = hit.slice(0, 360).trim();
        }
      }
    }
    if (evidence && evidence.length < 20) evidence = undefined;
  }

  let verification: VerificationState;
  if (verbatim) {
    verification = "VERIFIED_QUOTE";
  } else if (!paraphrased) {
    verification = "UNSUPPORTED";
  } else if (isRestricted) {
    verification = "ABSTRACT_LIMITED";
  } else if (evidence) {
    verification = "VERIFIED_PARAPHRASE";
  } else {
    verification = "PLAUSIBLE_UNVERIFIED";
  }

  let finalUrl = data.sourceUrl;
  if (safeSourceUrl && !options.skipLinkProbe) {
    const ok = await probeUrl(safeSourceUrl, fetchFn, requestHeaders);
    if (!ok) finalUrl = fallbackUrl(finalUrl, data.source);
  }

  return {
    quote: tooShort ? "" : finalQuote,
    attribution: (parsed.attribution ?? data.source).toString().trim(),
    context: mergedContext || undefined,
    verbatim,
    paraphrased,
    sourceUrl: finalUrl,
    fetched,
    verification,
    evidence,
  };
}

/**
 * Example provider wrapper. Keep this in app-specific code, not in the shared
 * package, when you wire it to OpenAI/Anthropic/Gemini/Lovable/etc.
 */
export function createJsonApiCitationProvider(args: {
  endpoint: string;
  apiKey?: string;
  model?: string;
  authHeaderName?: string;
  fetchFn?: typeof fetch;
  includeProviderErrorBody?: boolean;
  buildRequestBody?: (request: CitationModelRequest, model?: string) => unknown;
  parseResponse?: (response: unknown) => CitationModelResponse;
}): CitationModelProvider {
  return {
    async generateCitationEvidence(request) {
      const fetchFn = args.fetchFn ?? globalThis.fetch;
      if (!fetchFn) throw new Error("No fetch implementation available. Provide args.fetchFn.");

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (args.apiKey) headers[args.authHeaderName ?? "Authorization"] =
        (args.authHeaderName ? args.apiKey : `Bearer ${args.apiKey}`);

      const res = await fetchFn(args.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(
          args.buildRequestBody
            ? args.buildRequestBody(request, args.model)
            : {
                model: args.model,
                messages: [
                  { role: "system", content: request.systemPrompt },
                  { role: "user", content: request.userPrompt },
                ],
                response_format: { type: "json_object" },
              },
        ),
      });

      if (!res.ok) {
        const body = args.includeProviderErrorBody ? await res.text().catch(() => "") : "";
        const detail = body ? `: ${body.slice(0, 200)}` : "";
        throw new Error(`Citation provider error ${res.status}${detail}`);
      }

      const json = await res.json();
      if (args.parseResponse) return args.parseResponse(json);

      const completion = json as { choices?: { message?: { content?: string } }[] };
      const content = completion.choices?.[0]?.message?.content ?? "{}";
      try {
        return JSON.parse(content) as CitationModelResponse;
      } catch {
        return { quote: content };
      }
    },
  };
}
