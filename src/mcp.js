'use strict';

const crypto = require('crypto');
const express = require('express');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');
const repository = require('./repository');
const service = require('./service');

const router = express.Router();

const LIST_ID_SCHEMA = z.string().regex(/^[a-zA-Z0-9_-]{1,32}$/).default('grocery').optional();

// CORS headers needed for MCP Inspector (browser-based dev tool)
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id',
};

// Resolve tenant from bearer token using mcpApiKeyHash GSI
async function resolveTenant(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7).trim();
  if (!token) return null;
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  return repository.getTenantByApiKeyHash(hash);
}

// Auth middleware — injects req.mcpTenant
async function authMiddleware(req, res, next) {
  try {
    const tenant = await resolveTenant(req.headers.authorization);
    if (!tenant) {
      res.status(401).json({ error: 'invalid_token', error_description: 'Missing or invalid bearer token.' });
      return;
    }
    req.mcpTenant = tenant;
    next();
  } catch (err) {
    console.error('MCP auth error:', { message: err.message });
    res.status(500).json({ error: 'server_error' });
  }
}

// OPTIONS — CORS preflight for MCP Inspector
router.options('/', (req, res) => {
  res.set(CORS_HEADERS).status(200).end();
});

// All MCP requests go through auth first
router.use(authMiddleware);

// Build a fresh McpServer with all tools registered
function buildMcpServer() {
  const server = new McpServer({ name: 'grocery-list', version: '1.0.0' });

  server.registerTool(
    'get_grocery_list',
    {
      title: 'Get Grocery List',
      description:
        'Returns the current grocery list with items, count, and version number. ' +
        'Call this before any write tool to get the current version. ' +
        'Does not modify the list. Authentication is handled by the bearer token — do not pass tenantId.',
      inputSchema: z.object({
        listId: LIST_ID_SCHEMA,
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ listId }, { authInfo }) => {
      const tenantId = authInfo?.extra?.tenantId;
      const result = await service.getList(tenantId, listId || 'grocery');
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  server.registerTool(
    'add_grocery_items',
    {
      title: 'Add Grocery Items',
      description:
        'Adds one or more items to the grocery list. ' +
        'Duplicate items (case-insensitive) are skipped automatically — safe to retry. ' +
        'Does NOT clear or replace existing items. ' +
        'Returns added items, skipped duplicates, and the new list count.',
      inputSchema: z.object({
        items: z.array(z.string()).min(1).max(20),
        listId: LIST_ID_SCHEMA,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ items, listId }, { authInfo }) => {
      const tenantId = authInfo?.extra?.tenantId;
      const result = await service.addItems(tenantId, listId || 'grocery', items, 'mcp');
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  server.registerTool(
    'remove_grocery_items',
    {
      title: 'Remove Grocery Items',
      description:
        'Removes items from the grocery list. ' +
        'ALWAYS call get_grocery_list first to get the current version and pass it as expectedVersion. ' +
        'Each selector is either { position, expectedValue } (safe for duplicates) or { name } (removes first match). ' +
        'Returns removed items, items not found, conflicts, and the new list count.',
      inputSchema: z.object({
        items: z.array(
          z.union([
            z.object({ position: z.number().int().min(1), expectedValue: z.string() }),
            z.object({ name: z.string().min(1) }),
          ])
        ).min(1),
        expectedVersion: z.number().int().min(0),
        listId: LIST_ID_SCHEMA,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ items: selectors, expectedVersion, listId }, { authInfo }) => {
      const tenantId = authInfo?.extra?.tenantId;
      try {
        const result = await service.removeItems(tenantId, listId || 'grocery', selectors, expectedVersion, 'mcp');
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        if (err.code === 'VERSION_CONFLICT') {
          return {
            isError: true,
            content: [{ type: 'text', text: err.message }],
          };
        }
        throw err;
      }
    }
  );

  server.registerTool(
    'clear_grocery_list',
    {
      title: 'Clear Grocery List',
      description:
        'DESTRUCTIVE — permanently removes all items from the grocery list. ' +
        'Always confirm with the user before calling. ' +
        'Call get_grocery_list first and pass its version as expectedVersion. ' +
        'Safe to call on an already-empty list.',
      inputSchema: z.object({
        expectedVersion: z.number().int().min(0).optional(),
        listId: LIST_ID_SCHEMA,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ expectedVersion, listId }, { authInfo }) => {
      const tenantId = authInfo?.extra?.tenantId;
      try {
        const result = await service.clearList(tenantId, listId || 'grocery', expectedVersion, 'mcp');
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        if (err.code === 'VERSION_CONFLICT') {
          return {
            isError: true,
            content: [{ type: 'text', text: err.message }],
          };
        }
        throw err;
      }
    }
  );

  server.registerTool(
    'replace_grocery_list',
    {
      title: 'Replace Grocery List',
      description:
        'DESTRUCTIVE — atomically replaces the entire grocery list with a new set of items. ' +
        'Use this when consolidating a meal plan into a fresh ingredient list. ' +
        'Call get_grocery_list first and pass its version as expectedVersion. ' +
        'Returns the previous count, new count, and new version.',
      inputSchema: z.object({
        items: z.array(z.string()).min(1).max(50),
        expectedVersion: z.number().int().min(0),
        listId: LIST_ID_SCHEMA,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ items, expectedVersion, listId }, { authInfo }) => {
      const tenantId = authInfo?.extra?.tenantId;
      try {
        const result = await service.replaceList(tenantId, listId || 'grocery', items, expectedVersion, 'mcp');
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        if (err.code === 'VERSION_CONFLICT') {
          return {
            isError: true,
            content: [{ type: 'text', text: err.message }],
          };
        }
        throw err;
      }
    }
  );

  return server;
}

// Stateless MCP handler — new transport per request
router.all('/', async (req, res) => {
  res.set(CORS_HEADERS);
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = buildMcpServer();
    await server.connect(transport);

    // Pass tenantId via req.auth so the transport delivers it to tool handlers as authInfo
    req.auth = {
      token: 'bearer',
      clientId: req.mcpTenant.tenantId,
      scopes: ['mcp'],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      extra: { tenantId: req.mcpTenant.tenantId },
    };

    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('MCP handler error:', { message: err.message });
    if (!res.headersSent) {
      res.status(500).json({ error: 'internal_server_error' });
    }
  }
});

module.exports = router;
