## Primary QA user token

```
node scripts/get-token.js postman.qa.tester@easyblogger.com
```

for protected authentication, profile, payment, and subscription API tests as the primary test user.

## Chat receiver token

```
node scripts/get-token.js postman.chat.receiver@easyblogger.com
```

when a chat test must make a request as the receiving user.

## Admin token

```
node scripts/get-token.js joshuaschultz7985@outlook.com
```

for protected admin API tests.

## Fresh registration token

```
node scripts/create-test-user.js
```

Use the token written to `postman_token.txt` for `/api/auth/register` or `/api/auth/sync` tests. This command deletes and recreates the fixed QA test user.

## Fresh chat receiver token

```
node scripts/create-chat-receiver.js
```

Use the token written to `postman_receiver_token.txt` when the chat receiver must be recreated. This command deletes and recreates the fixed receiver test user.

To refresh an existing user's token without deleting data, rerun `get-token.js` with that user's email.
