# Admin Data Scope Design

**Date:** 2026-07-26
**Status:** Approved for planning

## Objective

Make an administrator's personal runs and leads the default dashboard view while preserving an explicit cross-user oversight view. This prevents other users' activity from appearing to be part of the administrator's own totals without weakening existing administrator access.

## Current Behavior

Runs and leads already retain their owning `userId`. Normal users are restricted to their own records, and administrators can access every record.

The confusing behavior is limited to administrator list queries: `GET /api/runs`, `GET /api/leads`, and `GET /api/leads/download` omit the owner filter for administrators. Consequently, the dashboard totals, run history, lead lists, and downloads combine all users by default.

Quotas, run creation, Nova shuffle history, extension sessions, and direct run authorization are already user-scoped and are outside this change.

## Selected Experience

An administrator-only scope control will offer:

- **My Data** — the default after every sign-in and full page reload.
- **All Users** — an explicit oversight view selected for the current page session only.

Changing the control refreshes the affected surfaces together:

- Runs, Leads, and Active dashboard totals
- Run History
- Lead run filters
- Google Maps and Sales Navigator lead lists
- Lead downloads
- Hiring run choices derived from the visible run list

The selection will not be stored in local storage, a cookie, or the database. A reload therefore always returns to **My Data**.

In **All Users**, owner usernames will be visible wherever records could otherwise be mistaken for the administrator's own data, including run rows, run filter choices, and lead rows.

Non-administrators will not see the control.

## API Contract

The affected endpoints accept an optional `scope` query parameter:

- `GET /api/runs?scope=mine|all`
- `GET /api/leads?scope=mine|all`
- `GET /api/leads/download?scope=mine|all`

Rules:

1. Missing `scope` means `mine`.
2. `scope=all` is honored only for an authenticated administrator.
3. A non-administrator requesting `scope=all` still receives only their own records. This fail-closed behavior prevents disclosure and keeps the endpoint safe for manipulated browser requests.
4. Any other scope value returns HTTP 400 with a specific validation message.
5. Existing filters such as `runId`, `leadSource`, and `format` continue to compose with the selected scope.

The owner filter will be built in one shared helper so run listing, lead listing, and downloads cannot drift apart.

Run responses retain their existing `user.username` owner information. Lead list responses add owner attribution derived from the lead's run. Download output remains in its current format; requesting an all-user download is already an explicit administrator action.

## Authorization Boundaries

This change alters list scope, not ownership or permissions.

- A normal user can only list, download, inspect, stop, resume, enrich, or delete their own runs.
- An administrator can still directly inspect and manage any user's run.
- Daily quotas remain counted by the run owner's `userId`.
- Nova shuffle learning remains based on the signed-in user's own run history.
- Extension tokens, sessions, and extension-created runs remain tied to their owner.
- Saved BYOD credentials remain tied to their owner.

## Dashboard State and Flow

The browser maintains an in-memory scope value initialized to `mine`. After authentication:

1. The scope control is shown only when the current user is an administrator.
2. The initial runs and leads requests use `scope=mine`.
3. Selecting **All Users** sets the in-memory value to `all` and reloads runs and leads.
4. Metrics and filter choices are rebuilt from the newly scoped results.
5. Subsequent refreshes, downloads, polling reconciliations, and lane changes use the same in-memory scope.
6. A full reload or new sign-in initializes the value to `mine` again.

The control and summaries will visibly state the active scope so an all-user view cannot be confused with personal data.

## Error Handling

- Invalid API scope values return HTTP 400.
- If a scope refresh fails, the current rendered data remains in place and the existing toast/error mechanism reports the failure.
- The UI does not silently switch scopes after a failed request.
- Normal authorization failures retain the existing 401/404 behavior.

## Test Strategy

API tests will prove:

- Administrators receive only their own runs and leads by default.
- Administrators receive all owners' records only with `scope=all`.
- Normal users cannot broaden access with `scope=all`.
- Invalid scopes return HTTP 400.
- Downloads obey the same scope rules as lead listing.
- Existing direct administrator access remains unchanged.

UI tests will prove:

- The control exists and is administrator-only.
- Its initial in-memory value is `mine` and is not persisted.
- Runs, leads, downloads, metrics, and derived filters use the selected scope.
- Owner attribution is rendered in all-user views.

The full automated suite, TypeScript build, and browser JavaScript syntax checks must pass before the change is pushed.

## Out of Scope

- Changing database ownership fields or migrations
- Changing plan limits or quota accounting
- Changing Nova's per-user learning behavior
- Changing extension authentication or capture behavior
- Adding a separate administrator analytics page
- Persisting the administrator's scope selection
