const crypto = require('node:crypto');

// TTL constants (in seconds)
const CODE_TTL = 300;        // 5 minutes
const ACCESS_TTL = 86400;    // 24 hours
const REFRESH_TTL = 7776000; // 90 days

let secretsProvider = null;

function toBase64Url(buffer) {
  return buffer.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function fromBase64Url(str) {
  const padding = (4 - (str.length % 4)) % 4;
  const padded = str + '='.repeat(padding);
  const base64 = padded
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  return Buffer.from(base64, 'base64');
}

function timingSafeEqual(a, b) {
  if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b)) {
    return false;
  }
  if (a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

function setSecretsProvider(fn) {
  secretsProvider = fn;
}

async function getSecret() {
  if (process.env.OAUTH_SIGNING_SECRET) {
    return process.env.OAUTH_SIGNING_SECRET;
  }
  if (!secretsProvider) {
    throw new Error('Secrets provider not configured. Call setSecretsProvider() first.');
  }
  return secretsProvider();
}

function sign(payload, secret) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  if (!secret || typeof secret !== 'string') {
    return null;
  }

  let payloadStr;
  try {
    payloadStr = JSON.stringify(payload);
  } catch {
    return null;
  }
  const payloadEncoded = toBase64Url(Buffer.from(payloadStr, 'utf8'));

  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(payloadEncoded);
  const signature = toBase64Url(hmac.digest());

  return `${payloadEncoded}.${signature}`;
}

function verify(token, secret) {
  if (!token || typeof token !== 'string') {
    return null;
  }
  if (!secret || typeof secret !== 'string') {
    return null;
  }

  const parts = token.split('.');
  if (parts.length !== 2) {
    return null;
  }

  const [payloadEncoded, signatureEncoded] = parts;

  const expectedSignature = toBase64Url(
    crypto.createHmac('sha256', secret).update(payloadEncoded).digest()
  );

  if (!timingSafeEqual(Buffer.from(signatureEncoded), Buffer.from(expectedSignature))) {
    return null;
  }

  let payload;
  try {
    const payloadBuffer = fromBase64Url(payloadEncoded);
    payload = JSON.parse(payloadBuffer.toString('utf8'));
  } catch {
    return null;
  }

  if (!payload.t || !payload.k || !payload.exp) {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp <= now) {
    return null;
  }

  return payload;
}

function issueCode(tenantId, codeChallenge) {
  if (!tenantId || typeof tenantId !== 'string') {
    return null;
  }

  const payload = {
    t: tenantId,
    k: 'code',
    exp: Math.floor(Date.now() / 1000) + CODE_TTL,
  };

  if (codeChallenge && typeof codeChallenge === 'string') {
    payload.cc = codeChallenge;
  }

  return payload;
}

function issueAccessToken(tenantId) {
  if (!tenantId || typeof tenantId !== 'string') {
    return null;
  }

  return {
    t: tenantId,
    k: 'access',
    exp: Math.floor(Date.now() / 1000) + ACCESS_TTL,
  };
}

function issueRefreshToken(tenantId) {
  if (!tenantId || typeof tenantId !== 'string') {
    return null;
  }

  return {
    t: tenantId,
    k: 'refresh',
    exp: Math.floor(Date.now() / 1000) + REFRESH_TTL,
  };
}

async function verifyToken(tokenStr, kind) {
  if (!tokenStr || typeof tokenStr !== 'string') {
    return null;
  }
  if (!kind || typeof kind !== 'string') {
    return null;
  }

  const secret = await getSecret();
  const payload = verify(tokenStr, secret);

  if (!payload) {
    return null;
  }

  if (payload.k !== kind) {
    return null;
  }

  return payload;
}

function hashToken(tokenStr) {
  if (!tokenStr || typeof tokenStr !== 'string') {
    return null;
  }
  return crypto.createHash('sha256').update(tokenStr).digest('hex');
}

module.exports = {
  setSecretsProvider,
  getSecret,
  sign,
  verify,
  issueCode,
  issueAccessToken,
  issueRefreshToken,
  verifyToken,
  hashToken,
  ACCESS_TTL,
};
