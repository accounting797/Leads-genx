# Targeted Scraping Output Expansion Design

**Date:** 2026-08-03

## Goal

Make Targeted Scraping a simple, automatic, evidence-backed workflow that produces the largest practical set of public US or Canadian business contacts without allowing volume to override geography, source association, or deliverability checks.

This design expands the localhost Targeted Scraping MVP. It replaces preview-only document work and fixes the observed campaign in which an unresolved US bank market became an unrestricted worldwide business search.

## Operator Experience

The default interface is a short guided flow:

1. Choose `Office`, `Google`, `Bank`, or `Other` targeting.
2. For bank targeting, choose one or more banks and either US or Canada.
3. Describe the desired industries, company types, roles, and optional provider preferences in plain language or editable fields.
4. Review one automatically prepared summary and start the campaign.

Bank campaigns do not require the operator to manually arrange locations. Leads Gen X resolves the top 25 branch/ATM markets by default, with an adjustable limit, and displays each market in this order:

`area code -> city -> state/province -> ZIP/postal code`

Advanced controls, generated work units, Review contacts, and Rejected contacts remain available but are collapsed by default. Results open on the Strict tier.

## Automatic Bank-Market Resolution

Each selected bank is mapped to an authoritative institution identifier rather than searched only by its display name. US markets come from public FDIC branch-location data. Canadian banks use official public bank locator data or a maintained, provenance-tagged public location dataset. ATM-only results may supplement branch data when their source and location are explicit.

The resolver:

- counts locations by city and state/province;
- ranks markets by branch/ATM count;
- selects the configured top-N markets;
- resolves representative ZIP/postal codes;
- resolves the leading telephone area codes for each market from a bundled, versioned US/Canada numbering dataset;
- deduplicates overlapping bank markets; and
- records the source, retrieval time, and evidence for every generated geography.

Planning must fail visibly when no market can be resolved. It must never silently create a location-free work unit for a country-restricted campaign.

Resolved geography is persisted in the campaign and reused consistently by query planning, discovery, scoring, exports, and restarts.

## Query Module

The canonical query order is:

`phone <area-code> <city> <state/province> <ZIP/postal> <intent> <provider/domain> <document operator>`

Example:

`phone 602 Avondale AZ 85392 logistics "@comcast.net" filetype:pdf`

The planner creates deterministic combinations across selected banks, markets, industries, company types, roles, visible email providers, and supported document types. It avoids a Cartesian explosion by applying campaign limits and the adaptive scheduler described below.

The plain-language prompt is converted into explicit, reviewable targeting fields. Prompt intent must be present in executed discovery queries and relevance scoring; it cannot remain display-only text.

## Discovery Architecture

Discovery has two cooperating lanes:

### Business lane

The existing Docker Google Maps scraper is the local primary source, with the configured Google Places API as a bounded supplement. Every request receives the resolved city, state/province, postal code, and targeted business terms. Area code remains part of the generated evidence and query module; telephone results are checked against it when present.

Discovered public business websites are crawled for contact pages, team pages, location pages, sitemaps, and linked public documents.

### Public web and document lane

Executable web-search work units discover public webpages and indexed documents. The connector is isolated behind an interface so localhost search, an administrator-configured search API, or imported URLs can be used without changing parsing or qualification logic. Connector unavailability is reported explicitly; a work unit must not be labelled completed when it was only previewed.

No new paid provider is required for the core workflow. The application uses existing Docker and Google capabilities where applicable and locally processes discovered files. Search-engine coverage and upstream rate limits may affect volume and are displayed honestly.

## Document Download and Extraction

The following public file types execute rather than remain preview-only:

- PDF, including text-based page extraction;
- XLS and XLSX, preserving workbook and sheet provenance;
- CSV and TSV;
- DOCX;
- TXT; and
- HTML webpages.

Each downloader enforces content-type checks, file-size limits, timeouts, redirect limits, concurrency limits, and safe URL rules. Unsupported, encrypted, corrupt, oversized, or image-only files are quarantined with an explicit reason. OCR is outside this increment unless a local OCR dependency is already available and passes the same safety limits.

Extracted email candidates store the source URL, file type, page or sheet when available, surrounding text, extraction time, associated organization, and geography evidence. Parsers run locally and never execute macros or embedded programs.

## Contact Qualification

The pipeline accepts public B2B contacts from both organization domains and common consumer providers such as Gmail, Yahoo, Outlook, Hotmail, AOL, Comcast, and similar services.

An organization-domain email qualifies when the domain matches the targeted business website or other strong public organization evidence. A consumer-provider email qualifies only when the source explicitly presents it as the contact for the targeted business or professional. Merely appearing in an unrelated footer, script, example, author list, or adjacent record is insufficient.

Every candidate passes syntax and hygiene checks, source association, deduplication, geography enforcement, and domain MX validation. Domain MX validation does not prove that an individual mailbox exists or guarantee inbox placement; the interface states this limitation.

## Hard US/Canada Geography Gate

Country is a mandatory eligibility gate rather than a weighted score.

- US campaigns accept only evidence-backed US locations.
- Canadian campaigns accept only evidence-backed Canadian locations.
- A combined campaign accepts either country but no others.
- An explicit foreign address, country, country-code domain plus foreign context, or incompatible postal/region pattern is Rejected.
- Missing or ambiguous geography is Review at best and can never become Strict.
- Location-free country-restricted searches are invalid and cannot start.

The gate uses structured source location data first, then normalized address, postal-code, state/province, city, telephone, and document context. Short tokens such as `US`, `IN`, or `CA` are never matched as arbitrary substrings.

## Quality Tiers and Default Results

`Strict` means the record passed the hard geography gate, targeting rules, public-source association, hygiene rules, and configured domain-level mail checks. `Review` means potentially useful evidence remains ambiguous. `Rejected` means the record failed targeting, geography, association, syntax, or mail-domain checks.

Only Strict contacts appear in the default table and Strict export. Review and Rejected records remain accessible for audit with clear reason codes. Previously generated records are not silently relabelled; rerunning qualification creates auditable new decisions.

## Adaptive Output Optimization

Leads Gen X stores aggregate performance for each country, bank, market, area code, query pattern, provider, source connector, domain, and document type:

- candidates discovered;
- Strict, Review, Rejected, and foreign-country rates;
- valid-MX rate;
- duplicates;
- public-contact association rate;
- contacts per company;
- bytes, requests, and processing time; and
- transient and permanent failure rates.

The scheduler begins with bounded exploration across combinations, then allocates more remaining work to combinations with high unique Strict yield and less work to combinations dominated by duplicates, foreign locations, or rejections. Minimum exploration prevents a single early result from permanently starving other markets. Learning is local, transparent, resettable, and based on campaign performance rather than unrelated personal information.

The first implementation uses deterministic adaptive scoring because it works with little historical data and requires no paid AI service. Every priority change records its inputs and reason. The stored metrics can support a later ranking model once enough manually audited history exists.

## Scale and Limits

Campaign limits for markets, work units, pages, documents, bytes, rows, candidates, contacts per company, verification operations, and concurrent requests are adjustable. Defaults protect the localhost machine and public sites. Work is checkpointed so campaigns can resume safely.

Thousands of unique contacts are possible when the selected markets and public sources contain them, but the system does not promise or synthesize a fixed count. Success is measured by unique Strict yield and audited precision, not raw scraped strings.

## Failure Handling

- Bank-market resolution failure stops planning with a useful message.
- A failed discovery connector does not broaden geography or intent.
- Parser failures quarantine only the affected artifact.
- HTTP 429 and transient failures receive bounded backoff; permanent failures do not loop.
- Campaign status distinguishes completed, partially completed, waiting, stopped, and failed work.
- Progress shows markets resolved, work units executed, documents parsed, candidates extracted, and tier counts.

## Testing and Acceptance

Implementation follows test-driven development. Required tests include:

- the reported Chase/US campaign cannot generate location-free work;
- a Lagos address can never become Strict in a US or Canadian campaign;
- bank identifiers resolve ranked markets and leading area codes in the required order;
- plain-language industry intent reaches both executed queries and scoring;
- Gmail and similar addresses qualify only with explicit public contact association;
- PDF, XLS, XLSX, CSV, DOCX, TXT, and HTML fixtures produce provenance-linked candidates;
- corrupt, oversized, encrypted, image-only, and misleading-content-type files fail safely;
- adaptive scheduling favors high unique-Strict-yield combinations without eliminating exploration;
- restart and deduplication behavior remains deterministic;
- default UI and exports contain only Strict contacts; and
- the complete existing test suite, TypeScript build, database checks, Docker health check, and localhost smoke test pass.

A bounded live pilot uses one bank and a few markets first. A manually audited sample must show no foreign Strict records and correct business/person association before increasing to the top 25 markets and large document runs.

