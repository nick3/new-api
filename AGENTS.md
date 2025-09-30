# Repository Guidelines

## Project Structure & Module Organization
- `main.go` launches the Gin backend, loading cross-cutting helpers from `middleware/`, `logger/`, and configuration in `setting/`.
- HTTP flow maps from `router/` to handler logic in `controller/`, with business services in `service/`, persistence in `model/`, and shared contracts in `dto/` and `types/`.
- Frontend lives in `web/` (Vite + Bun), shared utilities in `common/` and `constant/`, docs in `docs/`, and maintenance scripts or migrations in `bin/`.

## Build, Test, and Development Commands
- `go run main.go` or `make start-backend` runs the API against the active `.env`; use `go build ./...` before raising a PR.
- Inside `web/`, execute `bun install` then `bun run dev`; bundle assets with `make build-frontend` when preparing releases.
- `docker compose up -d` spins up supporting services for end-to-end checks; shut down with `docker compose down`.

## Coding Style & Naming Conventions
- Back-end code must pass `gofmt` and `go vet ./...`; keep packages single-purpose and exported identifiers in PascalCase, internals in camelCase.
- Prefer dependency injection through interfaces, avoid cyclic imports, and centralize shared constants in `constant/`.
- Frontend follows Prettier (`bun run lint:fix`) and ESLint (`bun run eslint:fix`); stick to functional components, hook-based state, and kebab-case filenames in `web/public/`.
- Add new configuration keys to `.env.example` using uppercase snake_case with concise inline notes.

## Testing Guidelines
- Write table-driven `*_test.go` cases alongside implementation and run `go test ./... -race`; mock external services via interfaces.
- Use `bin/time_test.sh <domain> <key> <count> [model]` for latency baselines and document findings in PRs; add Vitest specs under `web/src/__tests__/` as UI logic grows.

## Commit & Pull Request Guidelines
- Follow the repository’s Conventional Commit pattern (`fix:`, `feat:`, `chore:`) with subjects ≤72 characters and informative bodies.
- PRs should outline scope, risk, verification, linked issues, and include screenshots or payload samples when altering UX or APIs; confirm Go build/test and frontend lint/build before requesting review.

## Security & Configuration Tips
- Keep secrets out of version control; rely on `.env` locally and managed secret stores in deployment.
- Rotate provider credentials through the admin console and document operational changes in `docs/`.
