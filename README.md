# Modular Dev Utils

Portable TypeScript utilities generalized from modular app development.

This repository is intended as a shared workspace for reusable, provider-agnostic utilities that can move between projects without depending on a proprietary IDE, a specific app backend, or a single AI vendor.

## Modules

### Citation Verification

`src/citations` contains a provider-agnostic citation verification core and framework-neutral verification UI metadata.

The citation core handles:

- citation input validation
- optional source fetching with backend-safe URL checks
- source-mode classification
- evidence extraction
- anti-hallucination checks for verbatim passages
- provider-independent citation generation through an injected model provider

The module does not require Lovable, Supabase, TanStack, OpenAI, Anthropic, Gemini, or any other proprietary dependency.

## Runtime Expectations

The utilities target modern TypeScript runtimes with standard Web APIs:

- `fetch`
- `AbortController`
- `URL`

For older Node versions or specialized runtimes, pass a custom `fetchFn` where supported.

## Development

```bash
npm install
npm run typecheck
```

## Repository Scope

This repo is for generalized utilities and development artifacts that can be reused across projects. Product-specific code should stay in its own app repository.
