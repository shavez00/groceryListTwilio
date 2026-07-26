'use strict';

const express = require('express');
const MessagingResponse = require('twilio').twiml.MessagingResponse;
const repository = require('../src/repository');

const router = express.Router();

const MAX_ITEM_LENGTH = 100;
const MAX_LIST_SIZE = 50;

// getTwilioSecrets is injected from twilio.js to share the cold-start SSM cache
let _getTwilioSecrets = null;
function setSecretsProvider(fn) {
  _getTwilioSecrets = fn;
}

router.post('/', async (req, res) => {
  const tenantId = req.body.To;
  const userId = req.body.From;
  const body = req.body.Body ?? '';
  const twiml = new MessagingResponse();
  const response = body.toLowerCase().trim();

  try {
    const authorized = await repository.isAuthorized(tenantId, userId);
    if (!authorized) {
      twiml.message("Sorry, your number is not authorized for this list.");
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(twiml.toString());
    }

    let command = '';
    if (response.startsWith('add'))       command = 'add';
    else if (response.startsWith('list'))     command = 'list';
    else if (response.startsWith('remove'))   command = 'remove';
    else if (response.startsWith('clear'))    command = 'clear';
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
        const { items } = await repository.readList(tenantId);
        if (items.length + newItems.length > MAX_LIST_SIZE) {
          twiml.message(`List is full. Max ${MAX_LIST_SIZE} items allowed.`);
          break;
        }
        items.push(...newItems);
        await repository.writeListUnconditional(tenantId, 'grocery', items, userId);
        twiml.message(`Added: ${newItems.join(', ')}`);
        break;
      }

      case 'list': {
        const { items } = await repository.readList(tenantId);
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
        const { items } = await repository.readList(tenantId);
        const targets = input.split(',').map(s => s.trim()).filter(s => s.length > 0);

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

        const uniqueSorted = [...new Set(indicesToRemove)].sort((a, b) => b - a);
        const removed = uniqueSorted.map(i => items.splice(i, 1)[0]);

        await repository.writeListUnconditional(tenantId, 'grocery', items, userId);
        twiml.message(`Removed: ${removed.reverse().join(', ')}`);
        break;
      }

      case 'clear': {
        await repository.writeListUnconditional(tenantId, 'grocery', [], userId);
        twiml.message("List cleared.");
        break;
      }

      case 'announce': {
        const announcement = body.substring(9).trim();
        const tenantRecord = await repository.getTenant(tenantId);
        const targets = tenantRecord?.authorizedNumbers ?? [];
        if (targets.length === 0) {
          twiml.message("No authorized numbers found to announce to.");
          break;
        }
        const secrets = await _getTwilioSecrets();
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

module.exports = router;
module.exports.setSecretsProvider = setSecretsProvider;
