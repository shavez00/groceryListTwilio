# Grocery List Twilio — Documentation

A serverless SMS-driven grocery list application. Text a Twilio number to add, remove, and view items on a shared family grocery list. Built for multiple families, each with their own Twilio number and isolated list.

## Table of Contents

1. [How the Application Works](how-it-works.md) — user-facing behavior, SMS commands, request lifecycle
2. [Architecture Overview](architecture.md) — AWS services, how they connect, data flow diagrams
3. [Data Model](data-model.md) — DynamoDB table schemas, multi-tenancy design
4. [Codebase Guide](codebase.md) — file structure, how the code is organized, key functions
5. [CI/CD Pipeline](cicd.md) — GitHub Actions workflow, how deployments work
6. [Deployment Guide](deployment.md) — prerequisites, first-time setup, step-by-step deploy instructions
7. [Operations Guide](operations.md) — adding tenants, rotating credentials, monitoring, troubleshooting
8. [Coding & Documentation Standards](standards.md) — conventions to follow when changing this codebase
9. [Future Roadmap](roadmap.md) — planned MCP server integration and extensibility notes

## Quick Reference

| Item | Value |
|------|-------|
| Live endpoint | `https://grocerylist.vezcore.com/sms` |
| AWS region | `us-west-2` |
| CloudFormation stack | `grocery-list-twilio` |
| Lambda function | `grocery-list-twilio` |
| DynamoDB tables | `GroceryTenants`, `GroceryLists` |
| GitHub repo | `shavez00/groceryListTwilio` |
| CI/CD trigger | Push to `master` branch |
