# Surepass KYC Integration Configuration

## Environment Variables

Set these variables in your backend environment:

```
SUREPASS_CLIENT_ID="your-company@surepass.io"
SUREPASS_CLIENT_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
SUREPASS_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"
SUREPASS_API_TOKEN="your-bearer-token"
SUREPASS_BASE_URL="https://sandbox-encrypted.surepass.app"
SUREPASS_TIMEOUT_MS="120000"
```

## Base URLs

- Sandbox: https://sandbox-encrypted.surepass.app
- Production: https://kyc-api-encrypted.surepass.app
- Superflow Sandbox: https://superflow-sandbox-encrypted.surepass.app
- Superflow Production: https://superflow-encrypted.surepass.app

## Security Requirements

- Do not log or commit private keys.
- Store PEM keys in environment variables or a secure key vault.
- Rotate tokens and keys as advised by Surepass.
- Never store full PAN/Aadhaar numbers in logs.

## Database Migration

Apply the migration file:

- backend/migrations/0002_surepass_kyc.sql

## API Routing

The Surepass routes are defined in backend/src/surepass-routes.ts. To expose the API endpoints in Express, wire the route registration into your server startup when you are ready to enable the integration.

## Sandbox Test Data

Use the sandbox PAN payload:

```
{ "pan_number": "ABCDE1234F" }
```

Expected response format:

```
{
  "success": true,
  "status_code": 200,
  "data": { ... },
  "message": null,
  "message_code": "success"
}
```
