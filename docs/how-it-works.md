# How the Application Works

## Overview

A family member texts a Twilio phone number with a simple command like `add milk`. Twilio receives the SMS and immediately forwards it as an HTTP POST to this application running on AWS Lambda. The app processes the command, updates DynamoDB, and responds with a TwiML XML message that Twilio converts back into an SMS reply.

```
Family member's phone
        │
        │  SMS: "add milk"
        ▼
  Twilio (SMS carrier)
        │
        │  HTTP POST to grocerylist.vezcore.com/sms
        ▼
  AWS Lambda (twilio.js)
        │
        ├─► DynamoDB (read/write list)
        │
        │  TwiML XML response: "Added: milk"
        ▼
  Twilio (SMS carrier)
        │
        │  SMS reply: "Added: milk"
        ▼
Family member's phone
```

## SMS Commands

All commands are case-insensitive. The first word determines the command.

| Command | Example | What it does |
|---------|---------|--------------|
| `add {item}` | `add milk` | Appends one item to the grocery list |
| `add {item}, {item}, ...` | `add milk, eggs, bread` | Appends multiple items in one message |
| `list` | `list` | Returns the full list, numbered |
| `remove {#}` | `remove 2` | Removes item number 2 from the list |
| `remove {name}` | `remove eggs` | Removes the item matching that name (case-insensitive) |
| `remove {#},{#},...` | `remove 2,3,4` | Removes multiple items by number in one message |
| `remove {name},{name},...` | `remove eggs, bread` | Removes multiple items by name in one message |
| `clear` | `clear` | Empties the entire list |
| `announce {message}` | `announce dinner is ready` | Sends a broadcast SMS to all authorized numbers |
| anything else | `hello` | Returns the help message |

### Example Conversation

```
You:  add milk, eggs, bread
App:  Added: milk, eggs, bread

You:  list
App:  1. milk
      2. eggs
      3. bread

You:  add butter, cheese
App:  Added: butter, cheese

You:  list
App:  1. milk
      2. eggs
      3. bread
      4. butter
      5. cheese

You:  remove 2,3
App:  Removed: eggs, bread

You:  list
App:  1. milk
      2. butter
      3. cheese

You:  remove milk
App:  Removed: milk

You:  clear
App:  List cleared.
```

### Important: Each item is stored separately

When you text `add milk, eggs, bread`, the app splits on commas and stores three separate items. This means:

- `list` returns `1. milk  2. eggs  3. bread` — not `1. milk, eggs, bread`
- `remove 2` removes `eggs`, not the whole string
- Item names can contain spaces: `add almond milk` stores `almond milk` as one item

## Request Lifecycle (Step by Step)

1. **SMS sent** — A family member texts the Twilio number (e.g. `+15034448534`).

2. **Twilio webhook** — Twilio makes an HTTP POST to `https://grocerylist.vezcore.com/sms` with a form-encoded body containing at minimum:
   - `To` — the Twilio number that received the message (used as the tenant identifier)
   - `From` — the sender's phone number
   - `Body` — the text of the message

3. **API Gateway** — The request arrives at AWS API Gateway, which routes it to the Lambda function.

4. **Authorization check** — The Lambda looks up `To` in the `GroceryTenants` DynamoDB table and checks that `From` is in the `authorizedNumbers` list. If not, it returns "not authorized" immediately.

5. **Command parsing** — The first word of `Body` determines the command (`add`, `list`, `remove`, `clear`, `announce`).

6. **DynamoDB read/write** — The appropriate list operation runs against the `GroceryLists` table, keyed on `tenantId` (the `To` number) and `listId` (defaults to `"grocery"`).

7. **TwiML response** — The Lambda returns an XML response in Twilio's TwiML format. Twilio reads this and sends the text back to the family member.

## Multi-Tenancy

Each family has their own Twilio phone number. The `To` field on every incoming webhook identifies which family is texting, so a single deployed instance of this app can serve multiple families with completely isolated lists. There is no cross-tenant data access possible at the application level.

See [Data Model](data-model.md) for the full schema.

## Authorization

The app maintains an `authorizedNumbers` list per tenant in DynamoDB. Any number not on that list receives a rejection message and cannot read or modify the list. This prevents strangers who obtain the Twilio number from accessing a family's list.

---

## Troubleshooting

### "The list shows one item like '1. milk, eggs, bread' instead of separate items"

This happens when items were added before comma-splitting was supported, or by texting `add milk, eggs, bread` to an older version of the app. The entire string was stored as a single item.

**Fix:** Clear the list and re-add items:
```
clear
add milk, eggs, bread
```

Or clear it manually via the AWS CLI (see [Operations Guide](operations.md)).

### "remove eggs says 'not found' but eggs is on the list"

The name match is exact (case-insensitive). Check that the item was stored exactly as typed. Text `list` to see the exact spelling, then use `remove {exact name}` or `remove {#}` by number instead.

### "Sorry, your number is not authorized for this list"

Your phone number (`From`) is not in the `authorizedNumbers` list for this Twilio number (`To`). Contact whoever manages the app to have your number added. See [Operations Guide](operations.md) for how to add an authorized number.

### "remove 2 is out of range"

The list has fewer items than the number you sent. Text `list` first to see the current items and their numbers.

### No reply at all

1. Check that the Twilio webhook URL is set to `https://grocerylist.vezcore.com/sms` with method `POST`
2. Check the Lambda logs: `aws logs tail /aws/lambda/grocery-list-twilio --follow --region us-west-2`
3. Check the GitHub Actions deploy history to confirm the latest code is deployed
