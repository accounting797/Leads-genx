# Targeted Syntax-Valid Email Qualification Design

## Goal

Temporarily remove MX/DNS resolution from Targeted email qualification so resolver failures cannot reduce otherwise usable public leads to zero Valid results. Users will perform mailbox verification with an external service.

## Qualification contract

The user-facing **Valid** tier continues to use the internal `strict` identifier for API, database, export, and compatibility purposes.

A Targeted email is eligible for Valid when all of the following hold:

- Its normalized address has valid email syntax.
- It is not a placeholder, disposable-domain, automated/no-reply, telemetry, asset, or other obviously unusable address already rejected by the deterministic classifiers.
- It is publicly associated with the organization or is an explicitly published consumer/personal contact address.
- It satisfies the existing Targeted relevance and geography requirements.

Both business-domain addresses and qualifying public personal addresses are eligible. MX records and mailbox existence are not checked and must not influence the tier.

## Data flow

`classifyMailInfrastructure` becomes deterministic for Targeted qualification: obvious bad-address rules still reject; every remaining syntactically plausible address receives an accepted syntax-only result. The existing association and relevance layers remain unchanged and can still downgrade or reject an address.

The stored verification record remains explicit: depth is `syntax`, the reason identifies deterministic syntax qualification, and mailbox-verified counts remain zero. This avoids representing syntax-only leads as DNS- or mailbox-verified.

## Document scale

The existing extraction limits remain unchanged: up to 20,000 email candidates per artifact and up to 500 per parsed section/page/sheet. PDF, XLS, and XLSX parsing behavior is otherwise unchanged.

## Error handling

Targeted qualification performs no DNS network call, so MX timeouts and resolver errors disappear from this lane. Document discovery/fetch failures remain independently visible and continue to produce partial-completion diagnostics.

## Tests

- Prove a plausible business address becomes Valid without invoking the resolver.
- Prove a qualifying public consumer/personal address remains eligible.
- Prove malformed, placeholder, disposable, and automated/no-reply addresses remain rejected.
- Prove Targeted service candidates can reach the internal `strict`/user-facing Valid tier with syntax-only verification.
- Run the complete suite, TypeScript build, and browser JavaScript syntax checks before commit/push.

## Out of scope

- SMTP/mailbox verification.
- Debounce integration.
- Changing internal `strict` compatibility identifiers.
- Changing document extraction limits or discovery connectors.
