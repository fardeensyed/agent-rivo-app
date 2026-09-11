# Agent Rivo — independent audit, 11 September 2026

## Verdict

**Not ready for unconditional release: rotate the exposed Unipile API key first.**

The repository has a substantial working prototype, but prior claims that every error was resolved were not supported by sufficiently broad testing. This audit reproduced five additional failures before fixing them. After the changes, all 66 local tests and both builds pass. The live correction-to-validation flow was also retested: Draft 1 → correction → Draft 2 → validation of Draft 2, with no Draft 3 churn. Local tests do not prove live Unipile, Groq, Supabase RLS, database transactions, or browser behaviour.

Base commit: `f1e6910`. The remote main branch still points to that commit. Changes from this audit are local and uncommitted. No live database rows, provider configuration, credentials, or Git history were modified.

## Release blocker: exposed credential

A historical `.env.example` contains a Unipile API key that exactly matches the value currently configured locally. The value was never printed in tool output or copied into this report.

- Introduction/removal history: commits `385dbdd` and `48bdaf3`.
- Affected blob: `4a385399aa7e971f95bba25c8ca335e618c8e894`.
- Both commits are reachable from main and origin/main; the remote HEAD was checked.
- Severity: **critical credential exposure**. Actual provider validity was not tested; treat the key as compromised.
- Required action: revoke the old key in Unipile, create a replacement, put it only in local `.env`, restart, and verify one real message/voice round trip.
- Historical cleanup may follow rotation, coordinated with collaborators; rewriting history does not revoke a credential or remove existing clones.

The scan examined 5,148 historical text blobs, comparing current local secret values and selected credential patterns. Two other pattern hits were example private-key strings in historical dotenv documentation. This was a bounded scan, not proof that no other historical secret exists. Current `.env` is untracked and current `.env.example` uses placeholders.

## Confirmed defects and fixes

Paths/lines refer to the revised working tree; function names are the stable reference.

| Severity | Failure / evidence | Fix location and result |
|---|---|---|
| High | `I validate the latest draft if the numbers are correct.` finalised a report. Reproduced before fixing. | `backend/src/workflow.ts:35`, `isApprovalIntent`: whole-message affirmative grammar; conditions, negations, and unknown versions are rejected. Public P01 `I validate this report.` remains accepted. |
| High | Changing `50 boxes` to `5` changed a recorded `150 boxes` into `15 boxes`. Reproduced. | `backend/src/reporting.ts:102`: complete token boundaries and unique-match replacement. |
| High | Concurrent duplicate audio inserted two placeholders in the memory adapter; SQL uniqueness would turn the second insert into an error. Reproduced. | `backend/src/workflow.ts:95`: provider lock and recovery of the winning database insert. |
| High | `Do not cancel this visit.` cancelled it. Reproduced. | `backend/src/workflow.ts`, `isCancellationIntent`: cancellation must start as an explicit command; negated control text is excluded from findings. |
| Medium | `The tablet is not working.` was classified positive. Reproduced. | `backend/src/reporting.ts:123`: check common negative predicates before positive keywords. |
| High | Successful audio processing followed by a reply-send failure entered the transcription-failure handler. Confirmed by control-flow inspection. | `backend/src/server.ts:160`: reply failure is contained and cannot overwrite completed audio. No injected live Unipile failure was run. |
| High | Accepted notes could differ from the stored draft after an interrupted save. | `backend/src/workflow.ts`, `validate`: rebuild accepted facts and reject stale content before validation; regression verifies rejection. |
| Medium | Replaying a successful procedure question called the model and returned another reply. | `backend/src/workflow.ts`, `handleIncomingTextUnlocked`: completed questions do not repeat; failed attempts remain retryable. |
| Medium | Concurrent starts/state updates were protected only by provider ID, not by actor. | `backend/src/workflow.ts:61`: serialize actor workflows and draft/validation API actions in the single backend process; regression verifies one visit for concurrent starts. |
| Medium | An unmatched correction silently advanced the draft version without showing a changed report. | `prepareCurrentDraft`: unchanged report content retains its version; regression added. |
| High | A corrected Draft 2 could be falsely treated as stale during validation when its persisted `jsonb` field order differed from the regenerated object, causing Draft 3 churn. | `backend/src/workflow.ts`, semantic draft comparison: explicit fields ignore JSON key order, generated finding IDs, and source-ID ordering; exact correction→validation regression added. |
| Medium | Historical chat queries did not retrieve the authorised report. | `handleIncomingTextUnlocked`: scoped latest/last/previous report lookup with date/title/reference, without creating visit facts; positive and denied cases tested. |
| Medium | Relative deadlines used UTC and the visit start even when the note arrived later. | `backend/src/reporting.ts`, `resolveRelativeFollowUpDate`: note/correction timestamp and store timezone; regression covers a later note. |
| Medium | Audio had no two-minute limit, download bound was checked after full buffering, and processing lacked explicit timeouts. | `backend/src/integrations.ts`: 10 MB streamed cap, two-minute decoded duration check, download/FFmpeg/STT timeouts. Actual silent WAV decoding tested through FFmpeg. |
| High | Restart during transcription left pending audio capable of blocking future drafts indefinitely. | `backend/src/supabase-store.ts:12`, `recoverInterruptedAudio`, called before server listen: mark interrupted pending input failed and preserve accepted notes. Adapter test passes; live restart during transcription remains to be demonstrated. |
| High | Dashboard state and in-flight responses were not cleared when identities changed. | `frontend/src/main.tsx:27`: clear cached user data and reject responses from an earlier identity generation. Type/build checked; interactive account-switch test remains required. |

## Suspected audio-ID bug: not confirmed

The v1 Unipile webhook example supplies `message_id`, and the attachment endpoint requires the Unipile message identifier. The provider ID and Unipile ID are not established as interchangeable. There is no evidence here that replacing `message_id` with `provider_message_id` would work. The existing missing-ID failure remains intentionally safe; no speculative fallback was added.

Sources: [Unipile webhook payload](https://developer.unipile.com/docs/new-messages-webhook), [attachment endpoint](https://developer.unipile.com/reference/messagescontroller_getattachment), [message identifiers](https://developer.unipile.com/docs/message-payload).

## Acceptance matrix

PASS below means the inspected implementation and relevant local checks support the requirement. It does not assert a fresh live-service pass. PARTIAL identifies a remaining limitation; FAIL identifies a release blocker.

| ID | Result | Evidence / remaining verification |
|---|---|---|
| A01 | PASS, live retest due | Real Unipile adapter and replies; rotated key must be tested. |
| A02 | PASS, live retest due | Actual byte download, FFmpeg and Groq path; real phone recording needed after new limits. |
| A03 | PASS locally | Mixed-input draft tests. |
| A04 | PARTIAL | Tested corrections retain sources; arbitrary compound/name/deadline wording is not comprehensively supported. |
| A05 | PASS locally, delivery caveat | Negative/stale approvals blocked; atomic snapshot RPC inspected. No durable record proves that a WhatsApp draft reply was delivered. |
| A06 | PARTIAL | Core screens and local-date filters exist. Store cards link to latest visit rather than store history; report list lacks the specified author/summary columns. |
| A07 | PASS locally | Original evidence and scope checks present; live audio signed URL test due. |
| A08 | PARTIAL | Real embedding retrieval and citations; answerability is prompt/heuristic based, without claim-to-source verification or fresh adversarial live-model testing. |
| A09 | FAIL release security | API/RLS scope design inspected; exposed Unipile credential must be revoked. Live signed-in denial must be verified independently of unauthenticated denial. |
| A10 | PASS design, live proof due | Supabase persists state; single-process startup recovery added. No live database restart test performed here. |
| A11 | PASS locally, crash caveat | Unique provider key, text/audio replay tests, successful question replay fix. No durable transaction spans ingestion, state processing and reply delivery. |
| A12 | PARTIAL | Controlled failures and actual silent WAV rejection pass; heuristic speech gating cannot guarantee no hallucination. New startup recovery needs live verification. |
| A13 | PASS locally | Explicit switch and pending-note scope regression tests. |
| A14 | PASS documentation, clean setup unverified | Template, ordered migrations, seed and model configuration present; did not provision a second clean Supabase project. |

## Database review

- 001 creates the entities, provider-key uniqueness, one-active-visit constraint, RLS and vectors.
- 002 makes the audio bucket private. Existing bucket quota is 25 MB; the updated application enforces 10 MB before upload.
- 003 includes document version in vector retrieval and supports idempotent corpus upserts.
- 004 restricts unpublished visits/evidence to authors and procedures to mapped users.
- 005 locks the visit, validates current version, and stores the exact draft snapshot atomically. RPC execution is restricted to service_role.
- 006 writes visit state and draft in one transaction, but has no expected-prior-version comparison. Do not run multiple backend replicas: process locks do not coordinate them, and startup audio recovery assumes sole worker ownership.
- No SQL files changed. RPC tests use adapters, not a real PostgreSQL transaction/failure harness. Old validated visits without snapshots still fall back to report_drafts; no automatic historical backfill was run.

## Remaining risks

1. Rotate the exposed API key before release.
2. Run one backend only. Durable work ownership, processing acknowledgements, outbound retry and multi-process concurrency remain future reliability work. A crash after inserting a text command but before its side effect can cause replay to skip that command; accepted notes remain stored.
3. Voice filtering can reject quiet valid speech or accept noisy hallucinations. Review transcripts and allow explicit corrections.
4. Unusual corrections and some negated/compound statements remain imperfect; inspect generated reports. Dates such as ambiguous same-day "by Friday" still need clarification handling.
5. Dashboard history navigation and report-list metadata are incomplete against the detailed screen specification. Signed audio URLs are cached and require refresh after expiry. Some API errors use generic 400 status codes.
6. `npm audit --omit=dev --json` reports 6 affected packages: 4 high and 2 moderate. High findings are in the Transformers/ONNX/adm-zip/sharp dependency tree; this app uses text embeddings, not image decoding or user ZIP extraction, so exploitability is not established. The two moderate findings concern qs/Express. The API now uses the simple query parser, but this does not clear dependency advisories. An attempted compatible update did not change the locked versions; no forced major upgrade was made.
7. The static Unipile-Auth secret is the verified configuration path. The timestamped HMAC helper has local unit coverage but its provider compatibility was not established.

## Files changed

- `backend/src/workflow.ts`: approval, cancellation, concurrency, replay, history and stale-content checks.
- `backend/src/reporting.ts`: number boundaries, negation classification, date context, control filtering.
- `backend/src/integrations.ts`: audio duration, byte cap and timeouts.
- `backend/src/server.ts`: safe audio replies, serialized API actions, simple query parser and startup recovery.
- `backend/src/supabase-store.ts`: interrupted audio recovery.
- `frontend/src/main.tsx`: identity-change cache clearing and response guard.
- `backend/test/final-audit.test.ts`: 15 targeted regressions.
- `backend/test/workflow.test.ts`: correction-to-validation, repeated-approval, and persisted-JSON regression coverage.
- `backend/package.json`: includes new tests in the audit command.
- `README.md`: actual limitations, single-process requirement, header configuration and credential warning.
- `docs/final-audit-2026-09-11.md`: this report.

## Verification and score

Commands: `npm run check`, `npm test`, `npm run test:audit --workspace backend`, `npm run build --workspace backend`, `npm run build --workspace frontend`, `git diff --check`, and `npm audit --omit=dev --json`. The focused validation regression run uses `node --import tsx --test backend/test/workflow.test.ts`.

Final local tests: **66/66** (34 core + 32 audit). TypeScript and builds pass. Dependency audit is not clean. Clean-install, actual database transactions/RLS and real WhatsApp/Groq were not rerun. The correction-to-validation flow was live-tested after restart; credential rotation and the other live evidence items remain release prerequisites.

| Criterion | Score | Deduction |
|---|---:|---|
| WhatsApp, voice and continuity | 21/25 | Real integrations; speech/recovery and live retest limits. |
| Report accuracy, corrections, validation | 22/25 | Stronger regression coverage and snapshots; language breadth and delivery acknowledgement gaps. |
| Dashboard | 17/20 | Working core/filtering; detailed history/library requirements and UI testing gaps. |
| RAG/source quality | 8/10 | Real retrieval; heuristic relevance/answerability. |
| Reliability/access control | 7/15 | Exposed key, dependency advisories and crash/multi-worker gaps. |
| Reproducible setup/explanation | 4/5 | Useful instructions; fresh setup and candidate understanding not independently demonstrated. |
| **Total** | **79/100 provisional** | Release remains blocked by credential exposure. |

## Interview and submission

Demonstrate (1) real mixed text/voice, correction, stale rejection and exact snapshot; (2) authenticated Noah denial for a known Lyon visit and its audio; (3) supported and unsupported RAG answers plus restart/replay behaviour. Explain the distinction between migrations (schema changes) and seed (fictional initial data), and between a local mock test and a real provider/database test.

Before submission: rotate the key; restart a single backend/frontend; send one real audible note and one silent note; correct a fact, reject an old version, approve the current version; inspect snapshot and dashboard; verify Noah denial, restart and replay; review and commit/push these changes; submit the repository link with the remaining limitations disclosed. Hosting, Docker and photographs are optional under the handbook.
