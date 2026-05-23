# ScaleKit Integration Stage

The MVP keeps authentication out of the core search loop so the Apify cache, ranking pipeline, and lead workflow are easy to demo locally. ScaleKit should wrap the app after the search flow is stable.

## Intended Flow

1. User signs in with ScaleKit.
2. Backend receives a verified user identity.
3. Saved searches and leads are partitioned by `userId`.
4. Raw Apify cache remains shared because it is credit-saving infrastructure, not private user CRM state.

## Data Changes

When ScaleKit is added, extend saved user-owned records:

```json
{
  "userId": "scalekit-user-id",
  "personId": "person_...",
  "status": "saved",
  "notes": "Warm intro through Armenian founders group"
}
```

Use separate ownership for:

- `searches`: add `userId` so users see their own query history.
- `leads`: add `userId` so lead status and notes stay private.
- `profiles` and `raw-runs`: keep shared to preserve Apify credits across repeated searches.

## Backend Touchpoints

- Add ScaleKit middleware before `/api/search`, `/api/leads`, and future write APIs.
- Attach `req.user = { id, email, name }` after token/session verification.
- Pass `userId` into `saveSearch`, `getSearch`, `listLeads`, and `upsertLead`.

## Hackathon Demo Positioning

For the demo, the unauthenticated local app proves the agent loop. ScaleKit is the production path for turning it into a multi-user founder network where each user keeps private lead notes while the team benefits from shared cached discovery.
