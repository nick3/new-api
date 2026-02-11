# AGENTS.md — Project Conventions for new-api

## Overview

This is an AI API gateway/proxy built with Go. It aggregates 40+ upstream AI providers (OpenAI, Claude, Gemini, Azure, AWS Bedrock, etc.) behind a unified API, with user management, billing, rate limiting, and an admin dashboard.

## Tech Stack

- **Backend**: Go 1.22+, Gin web framework, GORM v2 ORM
- **Frontend**: React 18, Vite, Semi Design UI (@douyinfe/semi-ui)
- **Databases**: SQLite, MySQL, PostgreSQL (all three must be supported)
- **Cache**: Redis (go-redis) + in-memory cache
- **Auth**: JWT, WebAuthn/Passkeys, OAuth (GitHub, Discord, OIDC, etc.)
- **Frontend package manager**: Bun (preferred over npm/yarn/pnpm)

## Architecture & Project Structure

Layered architecture: Router -> Controller -> Service -> Model

- `main.go` launches the Gin backend; cross-cutting helpers live in `middleware/`, `logger/`, and configuration in `setting/`.
- Frontend lives in `web/` (Vite + Bun). Shared utilities live in `common/` and `constant/`.
- Docs live in `docs/`; maintenance scripts/migrations live in `bin/`.

Directory map:

```
router/        — HTTP routing (API, relay, dashboard, web)
controller/    — Request handlers
service/       — Business logic
model/         — Data models and DB access (GORM)
relay/         — AI API relay/proxy with provider adapters
  relay/channel/ — Provider-specific adapters (openai/, claude/, gemini/, aws/, etc.)
middleware/    — Auth, rate limiting, CORS, logging, distribution
setting/       — Configuration management (ratio, model, operation, system, performance)
common/        — Shared utilities (JSON, crypto, Redis, env, rate-limit, etc.)
dto/           — Data transfer objects (request/response structs)
constant/      — Constants (API types, channel types, context keys)
types/         — Type definitions (relay formats, file sources, errors)
i18n/          — Backend internationalization (go-i18n, en/zh)
oauth/         — OAuth provider implementations
pkg/           — Internal packages (cachex, ionet)
web/           — React frontend
  web/src/i18n/  — Frontend internationalization (i18next, zh/en/fr/ru/ja/vi)
```

## Build, Test, and Development Commands

- Backend dev: `go run main.go` or `make start-backend`
- Frontend dev: `cd web && bun install && bun run dev` (or `make dev-frontend`)
- Full dev (backend + frontend): `make dev`
- Frontend build: `make build-frontend`
- Go checks: `gofmt` + `go vet ./...` + `go test ./... -race`
- Docker for e2e dependencies: `docker compose up -d` / `docker compose down`

## Internationalization (i18n)

### Backend (`i18n/`)

- Library: `nicksnyder/go-i18n/v2`
- Languages: en, zh

### Frontend (`web/src/i18n/`)

- Library: `i18next` + `react-i18next` + `i18next-browser-languagedetector`
- Languages: zh (fallback), en, fr, ru, ja, vi
- Translation files: `web/src/i18n/locales/{lang}.json` — flat JSON, keys are Chinese source strings
- Usage: `useTranslation()` hook, call `t('中文key')` in components
- Semi UI locale synced via `SemiLocaleWrapper`
- CLI tools: `bun run i18n:extract`, `bun run i18n:sync`, `bun run i18n:lint`

## Rules (Hard Requirements)

### Rule 1: JSON Package — Use `common/json.go`

All JSON marshal/unmarshal operations MUST use the wrapper functions in `common/json.go`:

- `common.Marshal(v any) ([]byte, error)`
- `common.Unmarshal(data []byte, v any) error`
- `common.UnmarshalJsonStr(data string, v any) error`
- `common.DecodeJson(reader io.Reader, v any) error`
- `common.GetJsonType(data json.RawMessage) string`

Do NOT directly import or call `encoding/json` in business code. These wrappers exist for consistency and future extensibility (e.g., swapping to a faster JSON library).

Note: `json.RawMessage`, `json.Number`, and other type definitions from `encoding/json` may still be referenced as types, but actual marshal/unmarshal calls must go through `common.*`.

### Rule 2: Database Compatibility — SQLite, MySQL >= 5.7.8, PostgreSQL >= 9.6

All database code MUST be fully compatible with all three databases simultaneously.

**Use GORM abstractions:**

- Prefer GORM methods (`Create`, `Find`, `Where`, `Updates`, etc.) over raw SQL.
- Let GORM handle primary key generation — do not use `AUTO_INCREMENT` or `SERIAL` directly.

**When raw SQL is unavoidable:**

- Column quoting differs: PostgreSQL uses `"column"`, MySQL/SQLite uses `` `column` ``.
- Use `commonGroupCol`, `commonKeyCol` variables from `model/main.go` for reserved-word columns like `group` and `key`.
- Boolean values differ: PostgreSQL uses `true`/`false`, MySQL/SQLite uses `1`/`0`. Use `commonTrueVal`/`commonFalseVal`.
- Use `common.UsingPostgreSQL`, `common.UsingSQLite`, `common.UsingMySQL` flags to branch DB-specific logic.

**Forbidden without cross-DB fallback:**

- MySQL-only functions (e.g., `GROUP_CONCAT` without PostgreSQL `STRING_AGG` equivalent)
- PostgreSQL-only operators (e.g., `@>`, `?`, `JSONB` operators)
- `ALTER COLUMN` in SQLite (unsupported — use column-add workaround)
- Database-specific column types without fallback — use `TEXT` instead of `JSONB` for JSON storage

**Migrations:**

- Ensure all migrations work on all three databases.
- For SQLite, use `ALTER TABLE ... ADD COLUMN` instead of `ALTER COLUMN` (see `model/main.go` for patterns).

### Rule 3: Frontend — Prefer Bun

Use `bun` as the preferred package manager and script runner for the frontend (`web/` directory):

- `bun install` for dependency installation
- `bun run dev` for development server
- `bun run build` for production build
- `bun run i18n:*` for i18n tooling

### Rule 4: New Channel StreamOptions Support

When implementing a new channel:
- Confirm whether the provider supports `StreamOptions`.
- If supported, add the channel to `streamSupportedChannels`.

## Coding Style & Naming Conventions

- Back-end code must pass `gofmt` and `go vet ./...`; keep packages single-purpose and exported identifiers in PascalCase, internals in camelCase.
- Prefer dependency injection through interfaces; avoid cyclic imports; centralize shared constants in `constant/`.
- Frontend follows Prettier (`bun run lint:fix`) and ESLint (`bun run eslint:fix`); prefer functional components + hooks.
- Add new configuration keys to `.env.example` using uppercase snake_case with concise inline notes.

## Testing Guidelines

- Write table-driven `*_test.go` cases alongside implementation and run `go test ./... -race`; mock external services via interfaces.
- Use `bin/time_test.sh <domain> <key> <count> [model]` for latency baselines and document findings in PRs.
- If adding frontend tests, place them under `web/src/__tests__/` (create the directory when needed).

## Commit & Pull Request Guidelines

- Follow Conventional Commits (`fix:`, `feat:`, `chore:`) with subjects ≤72 characters and informative bodies.
- PRs should outline scope, risk, verification, linked issues, and include screenshots or payload samples when altering UX or APIs.
- Confirm Go build/test and frontend lint/build before requesting review.

## Security & Configuration Tips

- Keep secrets out of version control; rely on `.env` locally and managed secret stores in deployment.
- Rotate provider credentials through the admin console and document operational changes in `docs/`.
