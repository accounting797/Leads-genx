# Targeted resumable progress and runtime cutover design

## Goal

Run the updated Leads Gen X application against the user's existing production data, restore Nova Arrange to the standard Google Maps form, and make Targeted campaigns visibly advance and reliably reach a terminal state without discarding previously collected leads.

## Confirmed diagnosis

- Port 4177 is serving the legacy runtime directory at `C:\Users\Lenovo\Desktop\Leads-genx`, not the authoritative updated project at `C:\Users\Lenovo\Desktop\Leads-genx-remote`.
- The legacy dashboard does not contain the Nova Arrange control that is already present in the updated Google Maps form.
- Targeted run 23 has 700 planned units, with one XLSX unit marked `running` and 699 units `pending`. It has produced hundreds of candidates while `completedUnitCount` remains zero because progress is only persisted when the whole unit ends.
- The run began under the obsolete per-email MX path. Existing candidates and campaign history must be preserved.

## Runtime and data contract

The authoritative application is `C:\Users\Lenovo\Desktop\Leads-genx-remote`. It will be built and started on port 4177 while using the existing SQLite database at `C:\Users\Lenovo\Desktop\Leads-genx\prisma\dev.db`. The old server will be stopped only after its process identity and start time are verified. No campaign, candidate, credential, or run-history rows will be deleted.

Nova Arrange remains exclusive to the standard Google Maps form on the main dashboard. It must not appear in Targeted Scraping.

## Durable Targeted progress

`TargetedWorkUnit.checkpointJson` will store an operator-safe progress snapshot without a schema migration. A snapshot may include the current stage, processed item count, optional total item count, current source, success/failure counts, and heartbeat timestamp. Work-unit API records will expose the parsed snapshot as `progress` while retaining existing fields.

The Targeted dashboard will display:

- terminal units versus all planned units;
- the active unit's connector, document type, and query;
- its current stage and processed/total items when known;
- a recent heartbeat timestamp or elapsed wording;
- counts of completed, failed, skipped, running, and pending units.

Candidate funnel counts remain independent from work-unit completion counts.

## Completion and recovery

External web searches, downloads, and document operations must be bounded by their existing or explicit timeouts. Failure of one public document or URL is recorded and processing continues with the remaining sources. Candidate progress is checkpointed periodically so large PDF/XLS/XLSX files visibly move while retaining the existing limits of 20,000 candidates per artifact and 500 candidates per section/page/sheet.

On process startup, a persisted `running` work unit belonging to an interrupted queued/running campaign is returned to `pending` before execution resumes. A work unit must always leave `running` as `completed`, `failed`, `skipped_unavailable`, `skipped_budget`, or `cancelled`. After all units are terminal, the campaign becomes `completed`, `partially_completed`, `failed`, or `cancelled` according to accumulated outcomes. Previously saved candidates are deduplicated and retained during resume.

## Error handling

- A single document fetch or parse failure updates progress failure counts and does not trap the unit.
- A connector-level failure marks that unit failed and allows the campaign loop to continue.
- A stale/interrupted unit is recovered rather than counted as completed.
- Progress payloads contain no credentials or secret provider responses.
- Cancellation remains cooperative and preserves saved output.

## Testing

Regression coverage will prove:

1. Nova Arrange is present in Google Maps and absent from Targeted.
2. Work-unit progress checkpoints persist and are returned through the campaign API.
3. Large document processing updates checkpoint progress before the unit completes.
4. One bad document does not prevent later documents or units from completing.
5. Interrupted `running` units are reset and resumed without duplicating candidates.
6. Every non-cancelled test campaign reaches a terminal status with accurate unit counts.
7. The updated build can start against the preserved existing database.

