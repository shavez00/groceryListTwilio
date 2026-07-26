'use strict';

const crypto = require('crypto');
const express = require('express');
const repository = require('../src/repository');

const router = express.Router();

const BASE_URL = 'https://grocerylist.vezcore.com';

// RFC 8414 — OAuth Authorization Server Metadata
// ChatGPT fetches this to discover our token endpoint.
router.get('/.well-known/oauth-authorization-server', (req, res) => {
  res.json({
    issuer: BASE_URL,
    authorization_endpoint: `${BASE_URL}/oauth/authorize`,
    token_endpoint: `${BASE_URL}/oauth/token`,
    response_types_supported: ['code'],
    grant_types_supported: ['client_credentials'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
  });
});

// RFC 9728 — OAuth Protected Resource Metadata for /mcp
// Points clients at our authorization server.
router.get('/.well-known/oauth-protected-resource/mcp', (req, res) => {
  res.json({
    resource: `${BASE_URL}/mcp`,
    authorization_servers: [BASE_URL],
    bearer_methods_supported: ['header'],
  });
});

// Client credentials token exchange.
// client_secret IS the mcpApiKey UUID. We validate it by hashing and querying
// the GSI, then return it as the access_token — our existing Bearer auth
// middleware on /mcp can verify it without any changes.
router.post('/oauth/token', express.urlencoded({ extended: false }), async (req, res) => {
  const { grant_type, client_secret } = req.body;

  if (grant_type !== 'client_credentials') {
    return res.status(400).json({ error: 'unsupported_grant_type' });
  }

  // Support both client_secret_post (body) and client_secret_basic (Authorization header)
  const secret = client_secret || extractBasicSecret(req.headers.authorization);

  if (!secret) {
    return res.status(401).json({ error: 'invalid_client', error_description: 'client_secret is required' });
  }

  try {
    const hash = crypto.createHash('sha256').update(secret).digest('hex');
    const tenant = await repository.getTenantByApiKeyHash(hash);
    if (!tenant) {
      return res.status(401).json({ error: 'invalid_client', error_description: 'Unknown client credentials' });
    }
    return res.json({
      access_token: secret,
      token_type: 'bearer',
      expires_in: 86400,
    });
  } catch (err) {
    console.error('OAuth token error:', { message: err.message });
    return res.status(500).json({ error: 'server_error' });
  }
});

// Authorization endpoint — we only support client_credentials, not auth code flow.
router.get('/oauth/authorize', (req, res) => {
  res.status(400).json({ error: 'unsupported_response_type', error_description: 'Only client_credentials grant is supported' });
});

function extractBasicSecret(authHeader) {
  if (!authHeader?.startsWith('Basic ')) return null;
  const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  return colon >= 0 ? decoded.slice(colon + 1) : null;
}

module.exports = router;
