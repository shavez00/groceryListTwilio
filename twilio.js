#!/usr/bin/env node

const http = require('http');
const express = require('express');
const MessagingResponse = require('twilio').twiml.MessagingResponse;
const bodyParser = require('body-parser');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TENANTS_TABLE = process.env.TENANTS_TABLE || 'GroceryTenants';
const LISTS_TABLE = process.env.LISTS_TABLE || 'GroceryLists';
const DEFAULT_LIST = 'grocery';

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
      const item = body.substring(4).trim();
      if (!item) {
        twiml.message("Please specify an item to add.");
        break;
      }
      const items = await readList(tenantId);
      items.push(item);
      await writeList(tenantId, items, userId);
      twiml.message(`Added: ${item}`);
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
      const index = parseInt(input, 10);
      if (isNaN(index)) {
        twiml.message("Please send the number of the item to remove.");
        break;
      }
      const items = await readList(tenantId);
      if (index < 1 || index > items.length) {
        twiml.message(`Please enter a number from 1 to ${items.length}.`);
        break;
      }
      const removed = items.splice(index - 1, 1)[0];
      await writeList(tenantId, items, userId);
      twiml.message(`Removed: ${removed}`);
      break;
    }

    case 'clear': {
      await writeList(tenantId, [], userId);
      twiml.message("List cleared.");
      break;
    }

    case 'announce': {
      const announcement = body.substring(9).trim();
      const client = require('twilio')(
        process.env.apiKeySID,
        process.env.apiKeySecret,
        { accountSid: process.env.accountSID }
      );
      const targets = ['+15037812714', '+15035449035'];
      await Promise.all(targets.map(to =>
        client.messages.create({ from: tenantId, body: announcement, to })
      ));
      twiml.message(`Announced: ${announcement}`);
      break;
    }

    default:
      twiml.message("Commands: add {item}, remove {#}, list, clear, announce {message}");
      break;
  }

  res.writeHead(200, { 'Content-Type': 'text/xml' });
  res.end(twiml.toString());
});

// Lambda handler
const serverless = require('serverless-http');
module.exports.handler = serverless(app);

// Local dev entrypoint
if (require.main === module) {
  http.createServer(app).listen(8080, () => {
    console.log('Express server listening on port 8080');
  });
}
