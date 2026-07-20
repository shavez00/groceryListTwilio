#!/usr/bin/env node

const http = require('http');
const express = require('express');
const MessagingResponse = require('twilio').twiml.MessagingResponse;
const bodyParser = require('body-parser');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { SSMClient, GetParametersCommand } = require('@aws-sdk/client-ssm');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ssm = new SSMClient({});
const TENANTS_TABLE = process.env.TENANTS_TABLE || 'GroceryTenants';
const LISTS_TABLE = process.env.LISTS_TABLE || 'GroceryLists';
const DEFAULT_LIST = 'grocery';
const MAX_ITEM_LENGTH = 100;
const MAX_LIST_SIZE = 50;

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

async function readList(tenantId, listId = DEFAULT_LIST) {
  const result = await dynamo.send(new GetCommand({
    TableName: LISTS_TABLE,
    Key: { tenantId, listId },
  }));
  return result.Item?.items ?? [];
}

async function writeList(tenantId, items, modifiedBy, listId = DEFAULT_LIST) {
  await dynamo.send(new PutCommand({
    TableName: LISTS_TABLE,
    Item: { tenantId, listId, items, updatedAt: new Date().toISOString(), lastModifiedBy: modifiedBy },
  }));
}

async function isAuthorized(tenantId, fromNumber) {
  const result = await dynamo.send(new GetCommand({
    TableName: TENANTS_TABLE,
    Key: { tenantId },
  }));
  if (!result.Item) return false;
  return result.Item.authorizedNumbers?.includes(fromNumber) ?? false;
}

app.post('/sms', async (req, res) => {
  const tenantId = req.body.To;
  const userId = req.body.From;
  const body = req.body.Body ?? '';
  const twiml = new MessagingResponse();
  const response = body.toLowerCase().trim();

  try {
    const authorized = await isAuthorized(tenantId, userId);
    if (!authorized) {
      twiml.message("Sorry, your number is not authorized for this list.");
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(twiml.toString());
    }

    let command = '';
    if (response.startsWith('add'))      command = 'add';
    else if (response.startsWith('list')) command = 'list';
    else if (response.startsWith('remove')) command = 'remove';
    else if (response.startsWith('clear')) command = 'clear';
    else if (response.startsWith('announce')) command = 'announce';

    switch (command) {
      case 'add': {
        const input = body.substring(4).trim();
        if (!input) {
          twiml.message("Please specify an item to add.");
          break;
        }
        const newItems = input.split(',').map(s => s.trim()).filter(s => s.length > 0);
        const longItem = newItems.find(s => s.length > MAX_ITEM_LENGTH);
        if (longItem) {
          twiml.message(`Item names must be ${MAX_ITEM_LENGTH} characters or fewer.`);
          break;
        }
        const items = await readList(tenantId);
        if (items.length + newItems.length > MAX_LIST_SIZE) {
          twiml.message(`List is full. Max ${MAX_LIST_SIZE} items allowed.`);
          break;
        }
        items.push(...newItems);
        await writeList(tenantId, items, userId);
        twiml.message(`Added: ${newItems.join(', ')}`);
        break;
      }

      case 'list': {
        const items = await readList(tenantId);
        if (items.length === 0) {
          twiml.message("List is currently empty.");
        } else {
          const formatted = items.map((item, i) => `${i + 1}. ${item}`).join('\n');
          twiml.message(formatted);
        }
        break;
      }

      case 'remove': {
        const input = body.substring(7).trim();
        const items = await readList(tenantId);
        const targets = input.split(',').map(s => s.trim()).filter(s => s.length > 0);

        // Resolve each target to a 0-based index (by number or by name)
        const indicesToRemove = [];
        for (const target of targets) {
          const num = parseInt(target, 10);
          if (!isNaN(num)) {
            if (num < 1 || num > items.length) {
              twiml.message(`${num} is out of range. List has ${items.length} item(s).`);
              indicesToRemove.length = 0;
              break;
            }
            indicesToRemove.push(num - 1);
          } else {
            const idx = items.findIndex(item => item.toLowerCase() === target.toLowerCase());
            if (idx === -1) {
              twiml.message(`"${target}" not found on the list.`);
              indicesToRemove.length = 0;
              break;
            }
            indicesToRemove.push(idx);
          }
        }

        if (indicesToRemove.length === 0) break;

        // Remove highest indices first so earlier indices stay valid
        const uniqueSorted = [...new Set(indicesToRemove)].sort((a, b) => b - a);
        const removed = uniqueSorted.map(i => items.splice(i, 1)[0]);

        await writeList(tenantId, items, userId);
        twiml.message(`Removed: ${removed.reverse().join(', ')}`);
        break;
      }

      case 'clear': {
        await writeList(tenantId, [], userId);
        twiml.message("List cleared.");
        break;
      }

      case 'announce': {
        const announcement = body.substring(9).trim();
        const tenantRecord = await dynamo.send(new GetCommand({
          TableName: TENANTS_TABLE,
          Key: { tenantId },
        }));
        const targets = tenantRecord.Item?.authorizedNumbers ?? [];
        if (targets.length === 0) {
          twiml.message("No authorized numbers found to announce to.");
          break;
        }
        const secrets = await getTwilioSecrets();
        const client = require('twilio')(
          secrets.apiKeySID,
          secrets.apiKeySecret,
          { accountSid: secrets.accountSID }
        );
        await Promise.all(targets.map(to =>
          client.messages.create({ from: tenantId, body: announcement, to })
        ));
        twiml.message(`Announced to ${targets.length} number(s): ${announcement}`);
        break;
      }

      default:
        twiml.message("Commands: add {item}, remove {#}, list, clear, announce {message}");
        break;
    }
  } catch (err) {
    console.error('SMS handler error:', err);
    twiml.message("Sorry, something went wrong. Please try again.");
  }

  res.writeHead(200, { 'Content-Type': 'text/xml' });
  res.end(twiml.toString());
});

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
