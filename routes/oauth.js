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
    grant_types_supported: ['authorization_code', 'client_credentials'],
    code_challenge_methods_supported: [],
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
  const { grant_type, code, client_secret } = req.body;

  // Resolve the raw API key from whichever grant type was used
  let apiKey;
  if (grant_type === 'authorization_code') {
    apiKey = code;
  } else if (grant_type === 'client_credentials') {
    apiKey = client_secret || extractBasicSecret(req.headers.authorization);
  } else {
    return res.status(400).json({ error: 'unsupported_grant_type' });
  }

  if (!apiKey) {
    return res.status(401).json({ error: 'invalid_grant', error_description: 'Missing code or client_secret' });
  }

  try {
    const hash = crypto.createHash('sha256').update(apiKey.trim()).digest('hex');
    const tenant = await repository.getTenantByApiKeyHash(hash);
    if (!tenant) {
      return res.status(401).json({ error: 'invalid_grant', error_description: 'Invalid credentials' });
    }
    return res.json({
      access_token: apiKey.trim(),
      token_type: 'bearer',
      expires_in: 86400,
    });
  } catch (err) {
    console.error('OAuth token error:', { message: err.message });
    return res.status(500).json({ error: 'server_error' });
  }
});

// Authorization endpoint — auth code flow.
// Shows a simple API key form; on submit validates the key and redirects
// back to ChatGPT with the key as the code (no server-side session needed
// since the key itself is a 122-bit secret and is validated again at token exchange).
router.get('/oauth/authorize', (req, res) => {
  const { redirect_uri, state, client_id } = req.query;
  if (!redirect_uri) {
    return res.status(400).send('Missing redirect_uri');
  }
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sign in — Grocery List</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 400px; margin: 80px auto; padding: 0 20px; color: #1a1a1a; }
    h1 { font-size: 1.4rem; margin-bottom: 4px; }
    p { color: #555; font-size: 0.9rem; margin-bottom: 24px; }
    label { display: block; font-size: 0.85rem; font-weight: 600; margin-bottom: 6px; }
    input[type=password] { width: 100%; box-sizing: border-box; padding: 10px 12px; font-size: 1rem; border: 1px solid #ccc; border-radius: 6px; margin-bottom: 16px; }
    button { width: 100%; padding: 10px; background: #2563eb; color: #fff; border: none; border-radius: 6px; font-size: 1rem; cursor: pointer; }
    button:hover { background: #1d4ed8; }
    .error { color: #dc2626; font-size: 0.85rem; margin-bottom: 12px; display: none; }
  </style>
</head>
<body>
  <h1>Grocery List</h1>
  <p>Enter your API key to connect ChatGPT to your grocery list.</p>
  <form method="POST" action="/oauth/authorize">
    <input type="hidden" name="redirect_uri" value="${escapeHtml(redirect_uri)}">
    <input type="hidden" name="state" value="${escapeHtml(state || '')}">
    <input type="hidden" name="client_id" value="${escapeHtml(client_id || '')}">
    <label for="api_key">API Key</label>
    <input type="password" id="api_key" name="api_key" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" required autofocus>
    <div class="error" id="err">Invalid API key. Check your key and try again.</div>
    <button type="submit">Sign in</button>
  </form>
</body>
</html>`);
});

router.post('/oauth/authorize', express.urlencoded({ extended: false }), async (req, res) => {
  const { redirect_uri, state, api_key } = req.body;

  if (!redirect_uri) return res.status(400).send('Missing redirect_uri');
  if (!api_key) return redirectError(res, redirect_uri, state, 'access_denied');

  try {
    const hash = crypto.createHash('sha256').update(api_key.trim()).digest('hex');
    const tenant = await repository.getTenantByApiKeyHash(hash);
    if (!tenant) return redirectError(res, redirect_uri, state, 'access_denied');

    // Use the validated key as the authorization code — it's a 122-bit secret
    // and is re-validated at token exchange, so no server-side session is needed.
    const params = new URLSearchParams({ code: api_key.trim() });
    if (state) params.set('state', state);
    return res.redirect(`${redirect_uri}?${params}`);
  } catch (err) {
    console.error('OAuth authorize error:', { message: err.message });
    return redirectError(res, redirect_uri, state, 'server_error');
  }
});

function redirectError(res, redirectUri, state, error) {
  const params = new URLSearchParams({ error });
  if (state) params.set('state', state);
  return res.redirect(`${redirectUri}?${params}`);
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function extractBasicSecret(authHeader) {
  if (!authHeader?.startsWith('Basic ')) return null;
  const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  return colon >= 0 ? decoded.slice(colon + 1) : null;
}

module.exports = router;
