# Targeted Scraping Design

Date: 2026-08-03
Status: Approved design, pending written-spec review
Audience: Lead Gen X administrators

## Objective

Add an admin-only Targeted Scraping workflow that produces evidence-backed public B2B contacts for commercial outreach campaigns. The workflow prioritizes campaign alignment and contact quality before volume. It must never label a contact as verified without current supporting evidence, infer private banking relationships, or include private consumer records.

The first release runs locally and uses the services already configured in Lead Gen X. It must not require a new paid subscription. Optional paid-provider adapters may be added later but remain disabled unless an administrator explicitly configures and enables them.

## Success gates

A contact reaches the default export only after passing these ordered gates:

1. Campaign alignment: the company/contact evidence matches the selected intent, geography, bank market, visible-domain rules, and mail-infrastructure rules. The pilot target is at least 95% relevance in a manually audited sample.
2. Public B2B evidence: the contact has a public source URL, source type, discovery time, and evidence excerpt. Private consumers and inferred bank customers are prohibited.
3. Contact accuracy: the email belongs to the represented company or is clearly labeled as a public webmail/ISP address. Person, role, and company claims are retained only when supported by public evidence.
4. Inbox readiness: syntax, domain, MX, disposable-address, suppression, and available mailbox checks pass. Verification age must not exceed 72 hours for the strict export. Catch-all and unknown results go to Review/Risky.
5. Compliance and hygiene: country rules, suppression lists, deduplication, and audit requirements pass. The target is at least 99% unique contacts.
6. Commercial output: the dashboard reports discovered, aligned, strict-export, mailbox-verified, review, rejected, and exported counts separately. Volume never overrides an earlier quality gate.

Public release remains an explicit future decision. It requires repeated benchmark runs, at least 10,000 strict-export contacts in a large benchmark, and a controlled-send bounce rate below 2%. These are release targets, not guarantees for every run.

## Scope

### Included

- An admin-only Targeted Scraping tab and guided wizard.
- A combined conversational and structured targeting step.
- Office, Google, Other/ISP, and Bank lead modes.
- Extensible visible-domain and MX/infrastructure provider catalogs.
- US and Canada targeting.
- Area-code-first geography selection.
- Bank-market planning with the top 25 qualified markets preselected by default.
- Editable query planning for public webpages and supported public documents.
- Extraction from HTML, PDF, XLS, XLSX, CSV, DOCX, and TXT.
- Public-source evidence, relevance scoring, normalization, deduplication, infrastructure classification, local verification, compliance classification, and tiered export.
- Up to 50 retained contacts per company, ranked by target fit and quality.
- Checkpointed and resumable runs.
- Quality-funnel metrics and rejection reasons.

### Excluded

- Private consumer leads.
- Identifying or inferring a person's bank or financial relationships.
- Login automation, credential harvesting, CAPTCHA bypass, paywall bypass, stealth scraping, or evasion of access controls.
- Guaranteed inbox placement, guaranteed lead counts, or guaranteed campaign performance.
- Automatic sending of outreach messages.
- New paid services as a requirement for version one.
- Public/non-admin access until a later approval.

## Administrator workflow

### Step 1: Describe the campaign

The administrator enters a natural-language description of the desired leads. The same screen contains editable structured chips. AI assistance may propose filters, but no proposal becomes active until represented in the structured state shown to the administrator.

Structured state includes:

- Lead mode: Office, Google, Other/ISP, or Bank.
- Business/contact intent: industries, company types, departments, roles, seniorities, and keywords in one combined targeting model.
- Visible email domains and domain families.
- Mail infrastructure/security providers.
- Bank institutions when Bank mode is selected.
- Country, area codes, states/provinces, cities, ZIP/postal codes, and radius.
- Maximum contacts per company, defaulting to 50.
- Quality and verification strictness.

### Step 2: Choose lead and provider filters

The provider catalog is data-driven rather than hard-coded into the UI.

Initial catalog groups include:

- Business mail and security: Microsoft 365, Google Workspace, Zoho, GoDaddy, Fastmail, Proton Business, Rackspace, Mimecast, Proofpoint, Cisco Secure Email/IronPort, Barracuda, SpamTitan, and administrator-added signatures.
- Public webmail/ISP: Gmail, Outlook/Hotmail, Yahoo/AOL, Comcast, AT&T, Verizon, Cox, Spectrum, iCloud, GMX, Mail.com, and administrator-added domains.
- Banks: national, regional, community, and credit-union entries in the US and Canada, with administrator-added institutions.

Visible-domain filters and MX/infrastructure filters remain separate. A contact may match either or both, and the evidence records which rule matched.

### Step 3: Plan geography

The default selection order is:

Country -> Area code -> State/Province -> City -> ZIP/Postal code -> Radius

Selections are multivalued and editable. The system validates the hierarchy so incompatible area-code, state/province, city, and postal selections cannot silently combine.

Bank mode first researches the selected institution's public branch/ATM footprint, ranks qualified markets, and proposes the top 25 area-code/city markets. The administrator may select 1 through all qualified markets before continuing.

US bank-market planning prefers official FDIC branch/location data. Canadian planning may use authorized official bank locators, operator-supplied files, or appropriately licensed data. Payments Canada directory content must not be commercially reproduced without permission.

### Step 4: Review the query plan

The planner creates deterministic work units from campaign intent and geography. It generates distinct query variants for normal webpages and supported document types rather than treating `pdf/xlsv` as literal query syntax.

Supported query/document variants include:

- General public web results.
- `filetype:pdf`.
- `filetype:xls` and `filetype:xlsx`.
- `filetype:csv`.
- `filetype:docx`.
- `filetype:txt`.

Each work unit records its geography, target filters, source connector, query text, estimated scope, status, and checkpoint. Administrators can add, remove, edit, enable, or disable units before launch. The UI flags empty, overly broad, contradictory, duplicated, or unsupported queries.

### Step 5: Run discovery and extraction

The zero-new-spend connector set uses what Lead Gen X already has:

- The local Docker Google Maps scraper.
- Existing Google Places credentials within an administrator-approved request budget.
- Existing Apify credentials and configured actors within existing account limits.
- Official public datasets and authorized public directories.
- Direct crawling of public URLs discovered through configured sources or supplied by the administrator.
- Administrator-imported source URLs and public documents.

The system does not scrape consumer search-result pages by disguising automation. A connector stops on authentication walls, CAPTCHAs, explicit blocking, 401, 403, or persistent 429 responses. Every URL and redirect is validated to prevent private-network access and unsafe schemes.

Documents have byte, page, row, redirect, and extraction limits. Extracted content is untrusted data. It can produce candidate facts but cannot issue instructions, reveal secrets, authorize actions, or change run scope.

### Step 6: Score, verify, and classify

Candidates are normalized into a common schema and scored before expensive website scanning or mailbox checks.

Relevance evidence may include:

- Company name, website, category, description, and public document context.
- Selected geography and source address.
- Combined business/contact intent terms.
- Selected visible-domain match.
- Selected MX/infrastructure signature match.
- Bank-market membership as a geographic signal only.

The system does not treat bank-market location as evidence that a company or person banks with that institution.

Verification stages are:

1. Email normalization and syntax.
2. Disposable, placeholder, telemetry, no-reply, and malformed-address rejection.
3. Public DNS domain and MX resolution.
4. Mail-provider and security-gateway classification from versioned MX signatures.
5. Company-domain relationship and source-evidence checks.
6. Suppression and duplicate checks.
7. Optional mailbox-level check when a configured existing capability can perform it responsibly. Unknown or catch-all outcomes cannot enter the strict tier.

Quality tier and verification depth are separate fields. A contact is never described as mailbox-verified when only syntax, domain, and MX checks were possible.

Output tiers are:

- Strict/Export-ready: passes every required current gate. Its verification-depth label states whether it is syntax-qualified, domain/MX-qualified, or mailbox-verified.
- Review/Risky: relevant and sourced but catch-all, unknown, stale, ambiguous, or otherwise unsuitable for the default export.
- Rejected: irrelevant, invalid, prohibited, duplicate-only, suppressed, or unsupported by evidence.

### Step 7: Review and export

The run dashboard shows a funnel with counts and conversion rates for every gate. Administrators can inspect contacts, evidence, matched filters, provider classifications, and rejection reasons.

Default export includes Strict/Export-ready only. Review/Risky requires an explicit alternate export action and a warning. Rejected records are never exported as campaign-ready leads.

The output uses Lead Gen X's normalized lead presentation while adding:

- Campaign and targeted-run identifiers.
- Quality tier and relevance score.
- Verification status, depth, and timestamp.
- Visible-domain classification.
- MX/infrastructure classification.
- Evidence source URL, type, excerpt, and discovery timestamp.
- Matched geography, provider, and intent rules.
- Compliance status and reason.

## Architecture

### Components

1. Target Intent Compiler: converts conversational input into validated editable structured filters.
2. Provider Catalog: stores visible-domain patterns, MX signatures, institution metadata, aliases, status, and catalog version.
3. Market Planner: resolves area-code geography and ranks bank markets.
4. Query Planner: creates deterministic, reviewable, checkpointed work units.
5. Discovery Connectors: Docker, Google Places, Apify, official datasets, authorized URL sources, and imports.
6. Safe Fetcher: validates URLs and redirects, enforces response limits, identifies blocking responses, and records provenance.
7. Document Extractors: isolated parsers for HTML, PDF, spreadsheets, CSV, DOCX, and text.
8. Candidate Normalizer: maps extracted records into a shared candidate model.
9. Relevance Engine: evaluates combined target fit before verification.
10. Infrastructure Classifier: resolves DNS/MX and matches versioned provider signatures.
11. Verification Pipeline: applies local checks and optional configured mailbox capabilities.
12. Compliance Gate: applies country, suppression, source, and evidence rules.
13. Run Coordinator: manages bounded concurrency, budgets, checkpoints, cancellation, resumption, and metrics.
14. Export Service: exports only the selected quality tier and preserves audit fields.

Each component exposes a typed interface and can be tested independently with recorded fixtures. Discovery connectors do not decide final lead quality; all candidates pass through the same relevance, verification, compliance, and export gates.

## Data model

The implementation adds these concepts without repurposing existing Google Maps runs:

- TargetedCampaign: owner, status, prompt, structured filters, country scope, limits, quality policy, timestamps.
- TargetedWorkUnit: campaign, connector, query, document type, geography, status, attempts, checkpoint, counts, error.
- SourceArtifact: canonical URL, source type, content metadata, retrieval status, discovery time, content hash, rights/authorization note.
- CandidateContact: normalized company/person/email fields, source relationship, target matches, relevance score, and current tier.
- ContactEvidence: candidate, source artifact, evidence type, excerpt, and extracted fields.
- ContactVerification: candidate, check type, status, reason, provider/signature version, checked time, and expiry.
- ProviderCatalogEntry: group, provider, match type, pattern/signature, aliases, country, enabled status, and version.
- TargetedRunEvent: campaign progress, gate counts, warnings, and safe diagnostic metadata.

Secrets are never stored in campaign filters, work units, events, evidence, or exported rows. Existing secret-storage behavior remains the only credential source.

## Concurrency, budgets, and scale

Every run has explicit limits for queries, pages, bytes, documents, rows, candidates, verification work, and contacts per company. Concurrency is bounded per connector and per origin. Rate limits and retry-after headers are honored. Only transient failures receive bounded retries with backoff.

Large sessions are processed as resumable partitions rather than one in-memory task. Counts are updated incrementally. Stopping a run preserves completed evidence and candidates. Resuming continues from stored checkpoints without re-fetching unchanged artifacts unless their freshness policy has expired.

The UI distinguishes target count from discovered candidates, aligned candidates, verified contacts, and exported contacts. It never predicts that a requested quantity is guaranteed.

## Error handling

- Validation errors block launch and identify the exact field or query.
- Missing Docker or credentials place affected work units in a waiting or skipped state without discarding other connector output.
- Authentication, CAPTCHA, access-denied, paywall, and persistent rate-limit responses stop that source; no evasion fallback is attempted.
- Unsupported or oversized documents are recorded with explicit rejection reasons.
- Parser failures quarantine only the artifact, not the entire campaign.
- A provider outage checkpoints the unit and reports whether it is retryable.
- Secret values, source document contents, query text containing sensitive operator input, and raw third-party error bodies are redacted from general logs.
- The campaign completes as successful, partial, waiting, cancelled, or failed based on explicit provider and quality outcomes.

## Admin access

All Targeted Scraping routes and UI elements require the existing ADMIN role. The server enforces authorization independently of whether the UI hides the tab. Non-admin requests receive a forbidden response and cannot enumerate campaigns, evidence, contacts, settings, or exports.

## Testing strategy

### Unit tests

- Prompt-to-filter parsing and validation.
- Provider catalog matching and versioning.
- Area-code/state/city/postal hierarchy validation.
- Bank-market ranking and top-25 selection.
- Query planning, deduplication, and filetype variants.
- URL/redirect validation and private-network rejection.
- Every document extractor using local fixtures.
- Candidate normalization and company-domain relationships.
- Relevance scoring with matched and deliberately irrelevant fixtures.
- DNS/MX classification fixtures for every initial provider family.
- Verification tier rules, expiry, catch-all handling, suppression, and deduplication.
- US/Canada compliance classification.
- Export tier enforcement.

### Integration tests

- Admin authorization for every new API route.
- Campaign creation through export using deterministic fake connectors.
- Checkpoint, stop, resume, retry, partial completion, and cancellation.
- Streaming gate metrics and error reasons.
- Secret redaction.
- Database cascades and campaign deletion behavior.

### Local pilot

The first live test uses one narrow US campaign, one area code/city market, a small administrator-approved Google request budget, and a bounded public-document set. The team manually audits a sample against the six success gates before increasing geography or volume. Canada and bank-market tests follow only after the general pipeline passes.

The Targeted Scraping feature remains admin-only until the agreed release metrics are repeatedly met and the administrator explicitly approves public access.

## References and constraints

- FDIC BankFind Suite: https://banks.data.fdic.gov/bankfind-suite
- Payments Canada financial institutions file: https://www.payments.ca/systems-services/payment-services/financial-institutions-file
- Google Custom Search transition notice: https://developers.google.com/custom-search/v1/overview
- Cloudflare public DNS over HTTPS: https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/
- FTC CAN-SPAM guidance: https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business
- CRTC CASL guidance: https://crtc.gc.ca/eng/com500/guide.htm
