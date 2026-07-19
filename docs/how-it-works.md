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
| `add {item}` | `add milk` | Appends the item to the grocery list |
| `list` | `list` | Returns the full list, numbered |
| `remove {#}` | `remove 2` | Removes item number 2 from the list |
| `clear` | `clear` | Empties the entire list |
| `announce {message}` | `announce dinner is ready` | Sends a broadcast SMS to all family members |
| anything else | `hello` | Returns the help message |

### Example Conversation

```
You:  add milk
App:  Added: milk

You:  add eggs
App:  Added: eggs

You:  add bread
App:  Added: bread

You:  list
App:  1. milk
      2. eggs
      3. bread

You:  remove 2
App:  Removed: eggs

You:  list
App:  1. milk
      2. bread

You:  clear
App:  List cleared.
```

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
