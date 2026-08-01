#!/usr/bin/env node

'use strict';

const http = require('http');
const express = require('express');
const bodyParser = require('body-parser');
const { SSMClient, GetParametersCommand } = require('@aws-sdk/client-ssm');

const smsRouter = require('./routes/sms');
const mcpRouter = require('./src/mcp');
const oauthRouter = require('./routes/oauth');
const token = require('./src/token');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.json());

const ssm = new SSMClient({});

// Fetched once per cold start and cached for the lifetime of the Lambda container
let twilioSecrets = null;
async function getTwilioSecrets() {
  if (twilioSecrets) return twilioSecrets;
  const result = await ssm.send(new GetParametersCommand({
    Names: [
      '/grocerylist/twilio/accountSID',
      '/grocerylist/twilio/apiKeySID',
      '/grocerylist/twilio/apiKeySecret',
    ],
    WithDecryption: true,
  }));
  const map = Object.fromEntries(result.Parameters.map(p => [p.Name, p.Value]));
  twilioSecrets = {
    accountSID: map['/grocerylist/twilio/accountSID'],
    apiKeySID: map['/grocerylist/twilio/apiKeySID'],
    apiKeySecret: map['/grocerylist/twilio/apiKeySecret'],
  };
  return twilioSecrets;
}

// Fetch OAuth signing secret for token signing/verification
let oauthSigningSecret = null;
async function getOauthSigningSecret() {
  if (oauthSigningSecret) return oauthSigningSecret;
  const result = await ssm.send(new GetParametersCommand({
    Names: ['/grocerylist/oauth/signingSecret'],
    WithDecryption: true,
  }));
  oauthSigningSecret = result.Parameters?.[0]?.Value;
  if (!oauthSigningSecret) {
    throw new Error('SSM parameter /grocerylist/oauth/signingSecret not found');
  }
  return oauthSigningSecret;
}

// Share the SSM cache with the SMS route (announce command needs Twilio creds)
smsRouter.setSecretsProvider(getTwilioSecrets);

// Wire OAuth signing secret for token signing/verification
token.setSecretsProvider(getOauthSigningSecret);

app.use(oauthRouter);
app.use('/mcp', mcpRouter);
app.use('/sms', smsRouter);

// Lambda handler
const serverless = require('serverless-http');
module.exports.handler = serverless(app);
module.exports.app = app;

// Local dev entrypoint
if (require.main === module) {
  http.createServer(app).listen(8080, () => {
    console.log('Express server listening on port 8080');
  });
}
