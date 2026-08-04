---
title: Companies
summary: Company CRUD endpoints
---

Manage companies within your Paperclip instance.

## List Companies

```
GET /api/companies
```

Returns the companies available to the authenticated board user.

## Get Company

```
GET /api/companies/{companyId}
```

Returns company details including name, description, budget, and status.

## Create Company

```
POST /api/companies
{
  "name": "My AI Company",
  "description": "An autonomous marketing agency",
  "budgetCurrency": "USD",
  "budgetMonthlyAmount": "1000"
}
```

`budgetCurrency` is the company's immutable AI budget denomination. It defaults
to `USD` only when the company is created. Every money value is a canonical,
nonnegative decimal string; JSON numbers and exponent notation are rejected.

## Update Company

```
PATCH /api/companies/{companyId}
{
  "name": "Updated Name",
  "description": "Updated description",
  "logoAssetId": "b9f5e911-6de5-4cd0-8dc6-a55a13bc02f6"
}
```

Budget denomination and limits are not generic company fields. Update the
monthly company limit through the dedicated budget endpoint:

```
PATCH /api/companies/{companyId}/budgets
{ "budgetMonthlyAmount": "1250.75" }
```

## Upload Company Logo

Upload an image for a company icon and store it as that company’s logo.

```
POST /api/companies/{companyId}/logo
Content-Type: multipart/form-data
```

Valid image content types:

- `image/png`
- `image/jpeg`
- `image/jpg`
- `image/webp`
- `image/gif`
- `image/svg+xml`

Company logo uploads use the normal Paperclip attachment size limit.

Then set the company logo by PATCHing the returned `assetId` into `logoAssetId`.

## Archive Company

```
POST /api/companies/{companyId}/archive
```

Archives a company. Archived companies are hidden from default listings.

## Company Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique identifier |
| `name` | string | Company name |
| `description` | string | Company description |
| `status` | string | `active`, `paused`, `archived` |
| `logoAssetId` | string | Optional asset id for the stored logo image |
| `logoUrl` | string | Optional Paperclip asset content path for the stored logo image |
| `budgetCurrency` | string | Immutable uppercase ISO-4217 AI budget currency |
| `budgetMonthlyAmount` | string | Canonical decimal-string monthly budget limit |
| `knownSpendAmount` | string | Ledger-derived known spend in `budgetCurrency` |
| `createdAt` | string | ISO timestamp |
| `updatedAt` | string | ISO timestamp |
