'use strict';

const request = require('supertest');
const crypto = require('crypto');

// Mock AWS SDK before loading any app modules
const mockDynamoSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockDynamoSend })) },
  GetCommand: jest.fn(input => ({ input })),
  PutCommand: jest.fn(input => ({ input })),
  QueryCommand: jest.fn(input => ({ input })),
  UpdateCommand: jest.fn(input => ({ input })),
}));
jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn().mockImplementation(() => ({ send: jest.fn().mockResolvedValue({ Parameters: [] }) })),
  GetParametersCommand: jest.fn(input => ({ input })),
}));

// Set OAuth signing secret for token verification in tests
process.env.OAUTH_SIGNING_SECRET = 'test-signing-secret';

const { app } = require('../twilio.js');

// Test tenants
const TENANT_A_ID = '+15550000000';
const TENANT_A_KEY = 'test-api-key-tenant-a-1234567890';
const TENANT_A_HASH = crypto.createHash('sha256').update(TENANT_A_KEY).digest('hex');

const TENANT_B_ID = '+15550001111';
const TENANT_B_KEY = 'test-api-key-tenant-b-9876543210';
const TENANT_B_HASH = crypto.createHash('sha256').update(TENANT_B_KEY).digest('hex');

function makeTenant(tenantId, hash) {
  return { tenantId, mcpApiKeyHash: hash, familyName: 'Test', authorizedNumbers: [] };
}

// Track revoked tokens across test calls
let revokedTokensByTenant = {};

// Helper: setup DynamoDB mocks for OAuth tests
function setupOAuthDynamo({ tenantA = true, tenantB = false, resetRevoked = true } = {}) {
  if (resetRevoked) {
    revokedTokensByTenant = {};
  }
  mockDynamoSend.mockImplementation(cmd => {
    const table = cmd.input?.TableName;
    const indexName = cmd.input?.IndexName;
    const key = cmd.input?.Key;

    // GetCommand for GroceryTenants (check for GetCommand by absence of UpdateExpression)
    if (table === 'GroceryTenants' && key && !indexName && !cmd.input?.UpdateExpression) {
      const tenantId = key.tenantId;
      if (tenantA && tenantId === TENANT_A_ID) {
        const tenant = makeTenant(TENANT_A_ID, TENANT_A_HASH);
        if (revokedTokensByTenant[TENANT_A_ID]) {
          tenant.revokedRefreshTokenHashes = new Set(revokedTokensByTenant[TENANT_A_ID]);
        }
        return Promise.resolve({ Item: tenant });
      }
      if (tenantB && tenantId === TENANT_B_ID) {
        const tenant = makeTenant(TENANT_B_ID, TENANT_B_HASH);
        if (revokedTokensByTenant[TENANT_B_ID]) {
          tenant.revokedRefreshTokenHashes = new Set(revokedTokensByTenant[TENANT_B_ID]);
        }
        return Promise.resolve({ Item: tenant });
      }
      return Promise.resolve({});
    }

    // GSI query for tenant lookup by hash
    if (table === 'GroceryTenants' && indexName === 'mcpApiKeyHash-index') {
      const hashValue = cmd.input?.ExpressionAttributeValues?.[':h'];
      if (tenantA && hashValue === TENANT_A_HASH) {
        return Promise.resolve({ Items: [makeTenant(TENANT_A_ID, TENANT_A_HASH)] });
      }
      if (tenantB && hashValue === TENANT_B_HASH) {
        return Promise.resolve({ Items: [makeTenant(TENANT_B_ID, TENANT_B_HASH)] });
      }
      return Promise.resolve({ Items: [] });
    }

    // UpdateCommand for revoking refresh tokens
    if (table === 'GroceryTenants' && cmd.input?.UpdateExpression?.includes('ADD')) {
      const tenantId = key.tenantId;
      const hashSet = cmd.input?.ExpressionAttributeValues?.[':hash'];
      if (hashSet && hashSet instanceof Set) {
        if (!revokedTokensByTenant[tenantId]) {
          revokedTokensByTenant[tenantId] = [];
        }
        hashSet.forEach(hash => revokedTokensByTenant[tenantId].push(hash));
      }
      return Promise.resolve({});
    }

    return Promise.resolve({});
  });
}

// Helper: compute S256 code challenge from verifier
function computeCodeChallenge(verifier) {
  return crypto
    .createHash('sha256')
    .update(verifier)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

beforeEach(() => {
  jest.clearAllMocks();
  setupOAuthDynamo();
});

// --- Discovery endpoint ---

describe('discovery endpoint', () => {
  test('GET /.well-known/oauth-authorization-server returns metadata', async () => {
    const res = await request(app).get('/.well-known/oauth-authorization-server');
    expect(res.status).toBe(200);
    expect(res.body.issuer).toBeDefined();
    expect(res.body.authorization_endpoint).toBeDefined();
    expect(res.body.token_endpoint).toBeDefined();
  });

  test('discovery advertises refresh_token in grant_types_supported', async () => {
    const res = await request(app).get('/.well-known/oauth-authorization-server');
    expect(res.body.grant_types_supported).toContain('refresh_token');
  });

  test('discovery advertises no code_challenge_methods (PKCE not supported)', async () => {
    const res = await request(app).get('/.well-known/oauth-authorization-server');
    expect(res.body.code_challenge_methods_supported).toEqual([]);
  });

  test('discovery advertises client_credentials grant', async () => {
    const res = await request(app).get('/.well-known/oauth-authorization-server');
    expect(res.body.grant_types_supported).toContain('client_credentials');
  });
});

// --- Authorization endpoint (GET) ---

describe('authorize GET', () => {
  test('renders API key form', async () => {
    const res = await request(app).get('/oauth/authorize?redirect_uri=https://example.com/callback');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Grocery List');
    expect(res.text).toContain('API Key');
    expect(res.text).toContain('api_key');
  });

  test('missing redirect_uri returns 400', async () => {
    const res = await request(app).get('/oauth/authorize');
    expect(res.status).toBe(400);
  });

  test('echoes hidden state field', async () => {
    const state = 'abc123xyz789';
    const res = await request(app).get(
      `/oauth/authorize?redirect_uri=https://example.com/callback&state=${state}`
    );
    expect(res.status).toBe(200);
    expect(res.text).toContain(`value="${state}"`);
  });
});

// --- Authorization endpoint (POST) ---

describe('authorize POST - phone normalization', () => {
  test('accepts 509-555-1234 format', async () => {
    const res = await request(app)
      .post('/oauth/authorize')
      .send({
        redirect_uri: 'https://example.com/callback',
        api_key: TENANT_A_KEY,
        state: 'test-state',
      });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('code=');
    expect(res.headers.location).toContain('state=test-state');
  });

  test('state round-trips in redirect', async () => {
    const state = 'my-unique-state-12345';
    const res = await request(app)
      .post('/oauth/authorize')
      .send({
        redirect_uri: 'https://example.com/callback',
        api_key: TENANT_A_KEY,
        state,
      });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain(`state=${state}`);
  });

  test('empty API key re-renders form with redirect', async () => {
    const res = await request(app)
      .post('/oauth/authorize')
      .send({
        redirect_uri: 'https://example.com/callback',
        api_key: '',
      });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('error=access_denied');
  });

  test('invalid API key re-renders form with redirect', async () => {
    const res = await request(app)
      .post('/oauth/authorize')
      .send({
        redirect_uri: 'https://example.com/callback',
        api_key: 'invalid-key-that-does-not-exist',
        state: 'test',
      });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('error=access_denied');
    expect(res.headers.location).toContain('state=test');
  });

  test('missing redirect_uri returns 400', async () => {
    const res = await request(app)
      .post('/oauth/authorize')
      .send({
        api_key: TENANT_A_KEY,
      });
    expect(res.status).toBe(400);
  });

  test('valid API key returns authorization code', async () => {
    const res = await request(app)
      .post('/oauth/authorize')
      .send({
        redirect_uri: 'https://example.com/callback',
        api_key: TENANT_A_KEY,
      });
    expect(res.status).toBe(302);
    const location = res.headers.location;
    expect(location).toContain('code=');
    expect(location).not.toContain('error');
  });

  test('authorization code in redirect equals trimmed API key', async () => {
    const trimmedKey = TENANT_A_KEY.trim();
    const res = await request(app)
      .post('/oauth/authorize')
      .send({
        redirect_uri: 'https://example.com/callback',
        api_key: `  ${TENANT_A_KEY}  `, // with spaces
      });
    expect(res.status).toBe(302);
    const params = new URL(`https://example.com${res.headers.location}`).searchParams;
    expect(params.get('code')).toBe(trimmedKey);
  });
});

// --- Token endpoint - authorization_code grant ---

describe('token exchange - authorization_code grant', () => {
  test('valid code returns access and refresh tokens', async () => {
    const res = await request(app)
      .post('/oauth/token')
      .send({
        grant_type: 'authorization_code',
        code: TENANT_A_KEY,
      });
    expect(res.status).toBe(200);
    expect(res.body.access_token).toBeDefined();
    expect(res.body.refresh_token).toBeDefined();
    expect(res.body.expires_in).toBe(86400);
    expect(res.body.token_type).toBe('bearer');
  });

  test('expired code returns 400', async () => {
    const token = require('../src/token');
    const expiredPayload = {
      t: TENANT_A_ID,
      k: 'code',
      exp: Math.floor(Date.now() / 1000) - 3600, // 1 hour in the past
    };
    const expiredCode = token.sign(expiredPayload, 'test-signing-secret');

    const res = await request(app)
      .post('/oauth/token')
      .send({
        grant_type: 'authorization_code',
        code: expiredCode,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  test('access token replayed as code returns 400', async () => {
    const token = require('../src/token');
    const accessPayload = token.issueAccessToken(TENANT_A_ID);
    const accessToken = token.sign(accessPayload, 'test-signing-secret');

    const res = await request(app)
      .post('/oauth/token')
      .send({
        grant_type: 'authorization_code',
        code: accessToken,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  test('refresh token replayed as code returns 400', async () => {
    const token = require('../src/token');
    const refreshPayload = token.issueRefreshToken(TENANT_A_ID);
    const refreshToken = token.sign(refreshPayload, 'test-signing-secret');

    const res = await request(app)
      .post('/oauth/token')
      .send({
        grant_type: 'authorization_code',
        code: refreshToken,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  test('missing code returns 401', async () => {
    const res = await request(app)
      .post('/oauth/token')
      .send({
        grant_type: 'authorization_code',
      });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_grant');
  });
});

// --- Token endpoint - refresh_token grant ---

describe('token exchange - refresh_token grant', () => {
  test('valid refresh token returns new tokens', async () => {
    const token = require('../src/token');
    const refreshPayload = token.issueRefreshToken(TENANT_A_ID);
    const refreshToken = token.sign(refreshPayload, 'test-signing-secret');

    const res = await request(app)
      .post('/oauth/token')
      .send({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      });
    expect(res.status).toBe(200);
    expect(res.body.access_token).toBeDefined();
    expect(res.body.refresh_token).toBeDefined();
    expect(res.body.expires_in).toBe(86400);
  });

  test('refresh token grant returns valid new tokens', async () => {
    const token = require('../src/token');
    const refreshPayload = token.issueRefreshToken(TENANT_A_ID);
    const originalRefreshToken = token.sign(refreshPayload, 'test-signing-secret');

    const res = await request(app)
      .post('/oauth/token')
      .send({
        grant_type: 'refresh_token',
        refresh_token: originalRefreshToken,
      });
    expect(res.status).toBe(200);
    expect(res.body.refresh_token).toBeDefined();
    expect(res.body.access_token).toBeDefined();
    // Verify new tokens are valid by trying to use the access token with MCP
  });

  test('expired refresh token returns 400', async () => {
    const token = require('../src/token');
    const expiredPayload = {
      t: TENANT_A_ID,
      k: 'refresh',
      exp: Math.floor(Date.now() / 1000) - 3600,
    };
    const expiredRefreshToken = token.sign(expiredPayload, 'test-signing-secret');

    const res = await request(app)
      .post('/oauth/token')
      .send({
        grant_type: 'refresh_token',
        refresh_token: expiredRefreshToken,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  test('tampered refresh token returns 400', async () => {
    const token = require('../src/token');
    const refreshPayload = token.issueRefreshToken(TENANT_A_ID);
    let refreshToken = token.sign(refreshPayload, 'test-signing-secret');

    // Tamper with the signature
    const parts = refreshToken.split('.');
    parts[1] = parts[1].split('').reverse().join('');
    const tamperedToken = parts.join('.');

    const res = await request(app)
      .post('/oauth/token')
      .send({
        grant_type: 'refresh_token',
        refresh_token: tamperedToken,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  test('refresh for deleted tenant returns 400', async () => {
    const token = require('../src/token');
    const refreshPayload = token.issueRefreshToken(TENANT_A_ID);
    const refreshToken = token.sign(refreshPayload, 'test-signing-secret');

    // Setup so tenant is not found
    setupOAuthDynamo({ tenantA: false, resetRevoked: true });

    const res = await request(app)
      .post('/oauth/token')
      .send({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  test('access token used as refresh token returns 400', async () => {
    const token = require('../src/token');
    const accessPayload = token.issueAccessToken(TENANT_A_ID);
    const accessToken = token.sign(accessPayload, 'test-signing-secret');

    const res = await request(app)
      .post('/oauth/token')
      .send({
        grant_type: 'refresh_token',
        refresh_token: accessToken,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  test('refresh token can only be used once (single-use enforcement)', async () => {
    const token = require('../src/token');
    const refreshPayload = token.issueRefreshToken(TENANT_A_ID);
    const refreshToken = token.sign(refreshPayload, 'test-signing-secret');

    // First use: should succeed
    const firstRes = await request(app)
      .post('/oauth/token')
      .send({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      });
    expect(firstRes.status).toBe(200);
    expect(firstRes.body.access_token).toBeDefined();
    expect(firstRes.body.refresh_token).toBeDefined();

    // Second use of same refresh token: should be rejected (token has been revoked)
    const secondRes = await request(app)
      .post('/oauth/token')
      .send({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      });
    expect(secondRes.status).toBe(400);
    expect(secondRes.body.error).toBe('invalid_grant');
    expect(secondRes.body.error_description).toContain('revoked');
  });
});

// --- Token endpoint - client_credentials grant ---

describe('token exchange - client_credentials grant', () => {
  test('valid mcpApiKey returns access token', async () => {
    const res = await request(app)
      .post('/oauth/token')
      .send({
        grant_type: 'client_credentials',
        client_secret: TENANT_A_KEY,
      });
    expect(res.status).toBe(200);
    expect(res.body.access_token).toBe(TENANT_A_KEY.trim());
    expect(res.body.token_type).toBe('bearer');
    expect(res.body.expires_in).toBe(86400);
    expect(res.body.refresh_token).toBeUndefined();
  });

  test('invalid mcpApiKey returns 401', async () => {
    const res = await request(app)
      .post('/oauth/token')
      .send({
        grant_type: 'client_credentials',
        client_secret: 'invalid-key-that-does-not-exist',
      });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_grant');
  });

  test('Basic auth client_secret returns access token', async () => {
    const auth = Buffer.from(`client:${TENANT_A_KEY}`).toString('base64');
    const res = await request(app)
      .post('/oauth/token')
      .set('Authorization', `Basic ${auth}`)
      .send({
        grant_type: 'client_credentials',
      });
    expect(res.status).toBe(200);
    expect(res.body.access_token).toBe(TENANT_A_KEY.trim());
  });

  test('missing client_secret returns 401', async () => {
    const res = await request(app)
      .post('/oauth/token')
      .send({
        grant_type: 'client_credentials',
      });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_grant');
  });
});

// --- Token endpoint - unsupported grant ---

describe('token exchange - unsupported grant', () => {
  test('unsupported_grant_type returns 400', async () => {
    const res = await request(app)
      .post('/oauth/token')
      .send({
        grant_type: 'implicit',
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unsupported_grant_type');
  });
});

// --- End-to-end flow ---

describe('end-to-end OAuth flow', () => {
  test('complete authorization code flow', async () => {
    // Step 1: GET authorize to fetch the form
    const getRes = await request(app)
      .get('/oauth/authorize?redirect_uri=https://example.com/callback&state=test123');
    expect(getRes.status).toBe(200);
    expect(getRes.text).toContain('API Key');

    // Step 2: POST authorize with valid API key
    const authRes = await request(app)
      .post('/oauth/authorize')
      .send({
        redirect_uri: 'https://example.com/callback',
        api_key: TENANT_A_KEY,
        state: 'test123',
      });
    expect(authRes.status).toBe(302);
    const location = authRes.headers.location;
    const params = new URL(`https://example.com${location}`).searchParams;
    const code = params.get('code');
    expect(code).toBe(TENANT_A_KEY.trim());
    expect(params.get('state')).toBe('test123');

    // Step 3: POST token to exchange code for access token
    const tokenRes = await request(app)
      .post('/oauth/token')
      .send({
        grant_type: 'authorization_code',
        code,
      });
    expect(tokenRes.status).toBe(200);
    expect(tokenRes.body.access_token).toBeDefined();
    expect(tokenRes.body.refresh_token).toBeDefined();

    // Step 4: Verify access token works with MCP
    const mcpRes = await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .set('Authorization', `Bearer ${tokenRes.body.access_token}`)
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '0' },
        },
      });
    expect(mcpRes.status).toBe(200);
  });

  test('complete refresh token flow', async () => {
    const token = require('../src/token');

    // Create a refresh token
    const refreshPayload = token.issueRefreshToken(TENANT_A_ID);
    const refreshToken = token.sign(refreshPayload, 'test-signing-secret');

    // Exchange refresh token for new access + refresh
    const res = await request(app)
      .post('/oauth/token')
      .send({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      });
    expect(res.status).toBe(200);
    expect(res.body.access_token).toBeDefined();
    expect(res.body.refresh_token).toBeDefined();

    // Verify new access token works with MCP
    const mcpRes = await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .set('Authorization', `Bearer ${res.body.access_token}`)
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '0' },
        },
      });
    expect(mcpRes.status).toBe(200);
  });
});

// --- Protected resource endpoint ---

describe('protected resource endpoint', () => {
  test('GET /.well-known/oauth-protected-resource/mcp returns metadata', async () => {
    const res = await request(app).get('/.well-known/oauth-protected-resource/mcp');
    expect(res.status).toBe(200);
    expect(res.body.resource).toBeDefined();
    expect(res.body.authorization_servers).toBeDefined();
    expect(res.body.bearer_methods_supported).toContain('header');
  });
});
