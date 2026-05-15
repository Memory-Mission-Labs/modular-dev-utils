import type { VerificationState } from "./citation.functions.portable";

export type VerificationTone = "success" | "supported" | "limited" | "warning" | "danger";

export interface VerificationVisual {
  label: string;
  short: string;
  tooltip: string;
  /** Framework-neutral semantic tone for design systems that do not use Tailwind. */
  tone: VerificationTone;
  /** Confidence from 0 to 1 for opacity, sorting, or analytics. */
  confidence: number;
  /** Portable color tokens for plain CSS, CSS-in-JS, native apps, or design systems. */
  colors: {
    border: string;
    background: string;
    text: string;
  };
  /** Optional Tailwind classes for projects that already use Tailwind. */
  chipClass: string;
  /** Opacity applied to the quote body to communicate confidence. */
  bodyOpacity: string;
  /** Whether the quote should ever be wrapped in typographic quotes. */
  isDirectQuote: boolean;
  /** Glyph for the chip — kept tiny and typographic, not iconographic. */
  glyph: string;
}

export function verificationVisual(state: VerificationState): VerificationVisual {
  switch (state) {
    case "VERIFIED_QUOTE":
      return {
        label: "Verified Quote",
        short: "verified quote",
        tooltip:
          "Exact verbatim text extracted directly from accessible source text or OCR.",
        tone: "success",
        confidence: 1,
        colors: {
          border: "#34d399",
          background: "rgba(52, 211, 153, 0.1)",
          text: "#6ee7b7",
        },
        chipClass: "border-emerald-400/70 bg-emerald-400/10 text-emerald-300",
        bodyOpacity: "opacity-100",
        isDirectQuote: true,
        glyph: "❝",
      };
    case "VERIFIED_PARAPHRASE":
      return {
        label: "Verified Paraphrase",
        short: "verified paraphrase",
        tooltip:
          "Meaning is supported by the source text, but wording is AI-paraphrased or summarized.",
        tone: "supported",
        confidence: 0.95,
        colors: {
          border: "#a3e635",
          background: "rgba(163, 230, 53, 0.1)",
          text: "#d9f99d",
        },
        chipClass: "border-lime-400/60 bg-lime-400/10 text-lime-200",
        bodyOpacity: "opacity-95",
        isDirectQuote: false,
        glyph: "≈",
      };
    case "ABSTRACT_LIMITED":
      return {
        label: "Abstract-Limited Paraphrase",
        short: "abstract-limited",
        tooltip:
          "Generated primarily from abstract/metadata due to inaccessible full text.",
        tone: "limited",
        confidence: 0.85,
        colors: {
          border: "#fbbf24",
          background: "rgba(251, 191, 36, 0.1)",
          text: "#fde68a",
        },
        chipClass: "border-amber-400/60 bg-amber-400/10 text-amber-200",
        bodyOpacity: "opacity-85",
        isDirectQuote: false,
        glyph: "§",
      };
    case "PLAUSIBLE_UNVERIFIED":
      return {
        label: "Plausible but Unverified",
        short: "plausible · unverified",
        tooltip:
          "Semantically likely, but the system cannot confidently verify against source text.",
        tone: "warning",
        confidence: 0.75,
        colors: {
          border: "#fb923c",
          background: "rgba(251, 146, 60, 0.1)",
          text: "#fed7aa",
        },
        chipClass: "border-orange-400/60 bg-orange-400/10 text-orange-200",
        bodyOpacity: "opacity-75",
        isDirectQuote: false,
        glyph: "?",
      };
    default:
      return {
        label: "Unsupported / Needs Review",
        short: "needs review",
        tooltip: "Claim currently lacks sufficient verification.",
        tone: "danger",
        confidence: 0.6,
        colors: {
          border: "#f87171",
          background: "rgba(248, 113, 113, 0.1)",
          text: "#fca5a5",
        },
        chipClass: "border-red-400/60 bg-red-400/10 text-red-300",
        bodyOpacity: "opacity-60",
        isDirectQuote: false,
        glyph: "·",
      };
  }
}
