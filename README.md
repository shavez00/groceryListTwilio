# Grocery List Twilio

A serverless application for managing a shared family grocery list via SMS and ChatGPT.

Family members text a Twilio phone number to add, remove, and view items. ChatGPT can read and write the same list directly via an MCP (Model Context Protocol) server — enabling prompts like "plan five dinners and add the missing ingredients to my grocery list."

## Features

- **SMS interface** — text commands to add, remove, list, and clear items
- **ChatGPT MCP integration** — 5 tools for reading and writing the list from any ChatGPT conversation
- **Multi-tenant** — each family gets their own Twilio number and isolated list
- **Serverless** — runs entirely on AWS Lambda + DynamoDB; no servers to manage
- **Optimistic locking** — safe concurrent writes between SMS and ChatGPT

## SMS Commands

| Command | Behavior |
|---------|----------|
| `add milk` | Adds one item |
| `add milk, eggs, bread` | Adds multiple items |
| `list` | Returns numbered list |
| `remove 2` | Removes item #2 |
| `remove eggs` | Removes by name (case-insensitive) |
| `remove 2,3` | Removes multiple items |
| `clear` | Empties the list |
| `announce {msg}` | Broadcasts to all family members |

## ChatGPT MCP Tools

| Tool | Description |
|------|-------------|
| `get_grocery_list` | Read the current list |
| `add_grocery_items` | Add items (duplicates skipped) |
| `remove_grocery_items` | Remove by position or name |
| `clear_grocery_list` | Empty the list |
| `replace_grocery_list` | Atomic clear + set (for meal-plan ingredient drops) |

Connect ChatGPT via **Settings → Connectors**, server URL: `https://grocerylist.vezcore.com/mcp`

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 20 |
| Framework | Express + `serverless-http` |
| MCP | `@modelcontextprotocol/sdk` v1.29.0 |
| Infrastructure | AWS SAM — Lambda, API Gateway, DynamoDB, Route 53, ACM |
| CI/CD | GitHub Actions — deploys on every push to `master` |
| Secrets | AWS SSM Parameter Store |

## Project Structure

```
twilio.js          — entry point
src/
  repository.js    — DynamoDB operations
  service.js       — business logic (shared by SMS and MCP)
  mcp.js           — MCP server and tool definitions
routes/
  sms.js           — SMS handler
  oauth.js         — OAuth 2.0 endpoints for ChatGPT auth
test/
  service.test.js
  mcp.test.js
twilio.test.js
template.yaml      — AWS SAM infrastructure
```

## Deployment

See [`docs/deployment.md`](docs/deployment.md) for the full from-scratch guide.

Quick deploy after setup — push to `master`:
```bash
git push origin master
```

Check status:
```bash
gh run list --repo shavez00/groceryListTwilio --limit 3
```

## Documentation

| File | Contents |
|------|----------|
| [`docs/how-it-works.md`](docs/how-it-works.md) | SMS commands, MCP tools, troubleshooting |
| [`docs/architecture.md`](docs/architecture.md) | AWS services, file structure, design decisions |
| [`docs/data-model.md`](docs/data-model.md) | DynamoDB schema, multi-tenancy, optimistic locking |
| [`docs/codebase.md`](docs/codebase.md) | Annotated walkthrough of every source file |
| [`docs/deployment.md`](docs/deployment.md) | From-scratch deploy guide |
| [`docs/operations.md`](docs/operations.md) | Adding tenants, rotating credentials, monitoring |
| [`docs/cicd.md`](docs/cicd.md) | CI/CD pipeline details |
| [`docs/standards.md`](docs/standards.md) | Coding conventions, how to add commands and tools |
| [`docs/roadmap.md`](docs/roadmap.md) | Completed features, known limitations, future ideas |

## Live Endpoints

| Endpoint | Purpose |
|----------|---------|
| `https://grocerylist.vezcore.com/sms` | Twilio SMS webhook |
| `https://grocerylist.vezcore.com/mcp` | MCP server for ChatGPT |
| `https://grocerylist.vezcore.com/oauth/authorize` | OAuth sign-in for ChatGPT connector |
| `https://grocerylist.vezcore.com/.well-known/oauth-authorization-server` | OAuth discovery |
