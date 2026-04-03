# Contributing to VantagePeers

Thanks for your interest in contributing to VantagePeers.

## Development Setup

```bash
# Clone the repo
git clone https://github.com/vantageos/vantage-peers.git
cd vantage-memory

# Install dependencies
bun install

# Set up Convex (creates a new dev deployment)
npx convex dev

# Set your embedding API key
npx convex env set AI_GATEWAY_API_KEY=your-openai-api-key
```

## Running Tests

```bash
# Convex unit tests (34 tests, no deployment needed)
npx vitest run

# MCP integration tests (29 tests, requires running Convex deployment)
bun scripts/test-mcp.ts
```

## Project Structure

```
convex/           # Convex backend functions and schema
mcp-server/       # MCP server that bridges Claude Code to Convex
scripts/          # Test scripts and utilities
```

## Making Changes

1. Create a feature branch from `main`
2. Make your changes
3. Run `npx convex dev --once` to verify Convex functions compile
4. Run `npx vitest run` to verify all 34 unit tests pass
5. Run `bun scripts/test-mcp.ts` to verify all 29 integration tests pass
6. Open a PR against `main`

## Commit Style

We use conventional commits:

- `feat:` — new feature
- `fix:` — bug fix
- `docs:` — documentation only
- `refactor:` — code change that neither fixes a bug nor adds a feature
- `test:` — adding or updating tests

## Code Style

- TypeScript throughout
- Tabs for indentation
- Follow existing patterns in `convex/` and `mcp-server/`

## Adding a New MCP Tool

1. Add the Convex function in `convex/` (query, mutation, or action)
2. Add the MCP tool definition in `mcp-server/server.ts`
3. Add a test in `scripts/test-mcp.ts`
4. Update the tool count in README.md

## Reporting Issues

Open an issue on GitHub with:
- What you expected to happen
- What actually happened
- Steps to reproduce
- Convex function logs if applicable

## License

By contributing, you agree that your contributions will be licensed under the [FSL-1.1-Apache-2.0](LICENSE) license.
