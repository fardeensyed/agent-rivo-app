# Agent Rivo — Field Visit Reporting

Agent Rivo is a TypeScript prototype for regional managers conducting store visits through WhatsApp. It accepts real text and voice notes, keeps them associated with the correct visit, produces a reviewable versioned report, and exposes the same data through an authenticated React dashboard.

This repository is designed for the Agent Rivo assessment. It uses fictional data and development-only accounts.

## What is implemented

- Real WhatsApp text collection and replies through Unipile.
- Real incoming audio download, private Supabase Storage, Groq transcription, and a playable source timeline.
- Mixed text/voice visit reporting, corrections, explicit draft approval, and report-version checks.
- Semantic stale-draft checks are stable across Supabase `jsonb` field ordering; a correction creates one revised draft and validation approves that exact version without draft-number churn.
- Procedure RAG over the supplied SOP corpus, with citations and an honest unsupported-answer path.
- Supabase Auth, server-side scope enforcement, RLS, private audio URLs, and two seeded regional-manager identities.
- React dashboard: overview, accessible stores, visit history, report library, detail timeline, copy, and browser print.
- Reproducible schema, fixture seed, RAG ingestion, workflow checks, and adversarial audit checks.

## Architecture

~~~mermaid
flowchart LR
  Phone[Controlled WhatsApp sender] --> Unipile[Unipile]
  Unipile -->|authenticated webhook| API[Express / TypeScript backend]
  API --> Workflow[Visit workflow and state machine]
  Workflow --> DB[(Supabase Postgres + RLS)]
  API --> Audio[Private Supabase Storage]
  API --> Groq[Groq speech-to-text and RAG answer generation]
  Groq --> API
  API --> Dashboard[React + Vite dashboard]
  Dashboard -->|Supabase Auth token| API
~~~

~~~mermaid
stateDiagram-v2
  [*] --> collecting: start a store visit
  collecting --> ready_for_review: prepare report
  ready_for_review --> collecting: new note or correction creates a newer draft
  ready_for_review --> validated: explicitly approve current draft
  collecting --> cancelled: cancel visit
  ready_for_review --> cancelled: cancel visit
  validated --> [*]
  cancelled --> [*]
~~~

The workflow—not the model—controls identity, store scope, state transitions, deduplication, and validation. AI output is only used for transcription and grounded procedural answers.

## Repository layout

~~~text
backend/                 Express API, workflow, integrations, tests
frontend/                React/Vite dashboard
supabase/migrations/     Database, storage, RLS, and procedure-search schema
docs/architecture.md     Concise architecture notes
.env.example             Safe environment-variable template
~~~

## Prerequisites

- Node.js 22 or later.
- A dedicated Supabase development project.
- A Groq API key with speech-to-text access.
- A Unipile development account connected to a controlled WhatsApp account.
- ngrok only for the live WhatsApp demo.

Docker, paid hosting, PDF export, OCR, photographs, and additional languages are not required by the assessment. A local application plus ngrok is sufficient for the live demo.

## Reproducible setup

### 1. Clone and install

~~~powershell
git clone https://github.com/fardeensyed/agent-rivo-app.git
cd agent-rivo-app
npm install
Copy-Item .env.example .env
~~~

Populate .env locally. Never commit it.

### 2. Configure environment variables

Required server-only values:

~~~env
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_SECRET_KEY=YOUR_SERVER_ONLY_SECRET
GROQ_API_KEY=YOUR_GROQ_KEY
UNIPILE_DSN=YOUR_UNIPILE_DSN
UNIPILE_API_KEY=YOUR_UNIPILE_KEY
UNIPILE_ACCOUNT_ID=YOUR_CONTROLLED_ACCOUNT_ID
UNIPILE_SENDER_ID=YOUR_CONTROLLED_WHATSAPP_SENDER_ID
UNIPILE_ACTOR_ID=user_anika
UNIPILE_WEBHOOK_SECRET=YOUR_WEBHOOK_SHARED_SECRET
APP_DASHBOARD_ORIGIN=http://localhost:5173
~~~

The browser may receive only these public values:

~~~env
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=YOUR_PUBLISHABLE_KEY
VITE_API_URL=http://localhost:3001/api
VITE_ENABLE_DEMO_MODE=false
ENABLE_LOCAL_TEST_RUNNER=false
~~~

All variable names and defaults are listed in .env.example.

### 3. Provision Supabase

In the Supabase SQL editor, run these migrations in order:

1. supabase/migrations/001_agent_rivo.sql
2. supabase/migrations/002_private_voice_storage.sql
3. supabase/migrations/003_procedure_chunk_upsert_and_version.sql
4. supabase/migrations/004_harden_read_scopes.sql
5. supabase/migrations/005_atomic_validated_report_snapshot.sql
6. supabase/migrations/006_atomic_visit_draft_save.sql

Migration 004 keeps drafts and message evidence private to their author until the visit is validated. Migration 005 atomically validates the visit and writes an immutable validated report snapshot. Migration 006 atomically saves ordinary visit state and draft changes.

### 4. Seed fixture data and procedure corpus

Set the candidate-kit directory, then seed and index it:

~~~powershell
$env:ASSESSMENT_KIT_DIR="C:\path\to\agent-rivo-candidate-kit-v2"
npm run seed --workspace backend
npm run rag:ingest --workspace backend
~~~

The seed uses upserts, so rerunning it does not duplicate the six supplied historical reports. For a completely clean demo, reset only the dedicated Supabase development project, rerun migrations, seed, and RAG ingestion. Do not use this reset process against production or unrelated data.

### 5. Create and map dashboard users

Create two confirmed email/password users in Supabase Authentication → Users, then map their UUIDs to the fixture users:

~~~sql
update public.app_users set auth_user_id = 'ANIKA_AUTH_UUID' where id = 'user_anika';
update public.app_users set auth_user_id = 'NOAH_AUTH_UUID' where id = 'user_noah';
~~~

Anika owns Lyon and Nantes. Noah owns Lille. The controlled WhatsApp sender is mapped server-side to Anika; a second phone number is not required for Noah’s access-control test.

## Run locally

Use three terminals for a live WhatsApp demo:

~~~powershell
# Terminal 1 — backend
npm run dev --workspace backend

# Terminal 2 — dashboard
npm run dev --workspace frontend

# Terminal 3 — public webhook tunnel, only for WhatsApp
ngrok http 3001
~~~

Open http://localhost:5173. Configure the Unipile webhook as:

~~~text
https://YOUR-NGROK-DOMAIN.ngrok-free.app/api/webhooks/whatsapp
~~~

Configure the custom `Unipile-Auth` header to match `UNIPILE_WEBHOOK_SECRET`. This is the verified integration path. The code also contains a timestamped HMAC verifier; its compatibility with a provider-supplied signature has not been established. A synthetic identity-selecting event is accepted only by the isolated in-memory test runner, never by the Supabase-backed public webhook.

## Models

Models are configurable in .env without source changes:

| Purpose | Variable | Default |
|---|---|---|
| Procedure answer generation | GROQ_CHAT_MODEL | openai/gpt-oss-20b |
| Speech-to-text | GROQ_STT_MODEL | whisper-large-v3-turbo |
| Procedure embeddings | EMBEDDING_MODEL | Supabase/gte-small |

## Verification

Run these before a demo or submission:

~~~powershell
npm run check
npm run test
npm run test:audit --workspace backend
npm run build --workspace frontend
~~~

The core workflow suite covers corrections, stale approval, replay, store switching, silent audio, RAG separation, pending audio, and authorization. The adversarial audit suite adds checks for public webhook identity bypass, negative approval wording, concurrent replay, compound correction safety, persistence, scoped evidence, and failure retry.

The latest local verification run passed **66/66 tests**: 34 core workflow tests and 32 release-audit tests. It also passed the backend/frontend TypeScript checks and both production builds. The live WhatsApp correction-to-validation flow was retested after restart: Draft 1 → correction → Draft 2 → validation of Draft 2, with no Draft 3 churn.

## Demo runbook

1. Sign in as Anika and show the seeded dashboard.
2. In WhatsApp, send Start a visit to Lyon.
3. Send a fresh voice note and a text observation.
4. Ask What should I record for an equipment incident? and show the cited SOP answer.
5. Correct one factual observation, prepare the report, and explicitly validate the current draft.
   If the correction is made after Draft 1, the response should show Draft 2 and validation should finalise Draft 2—not create Draft 3. A repeated approval should say the visit is already final.
6. Refresh the dashboard. Open the visit, play the original audio, inspect the transcript and sources, then copy or print the validated report.
7. Sign in as Noah. Show Lille-only dashboard scope and a forbidden response for an Anika/Lyon direct API or audio request.

## Acceptance coverage

| ID | Status | Demo evidence |
|---|---|---|
| A01 | Implemented; live integration evidence required | Real Unipile text appears in the active visit. |
| A02 | Implemented; heuristic limitation | Real phone recording is downloaded, transcribed, stored privately, and playable. |
| A03 | Implemented | Text and voice contribute to one report. |
| A04 | Implemented for tested/common wording | Revised draft retains original source inputs and correction trail; unusual compound wording may require clarification. |
| A05 | Implemented after migrations 005–006 | Current-version approval, stale-version rejection, final-state guard, and an immutable `validated_reports` snapshot are written atomically. |
| A06 | Implemented | Dashboard screens, real data, source timeline, report library, copy/print, and inclusive store/state/date/search filters work together. |
| A07 | Implemented with scoped access | Authorised users can inspect text, transcript, and private signed audio URL. |
| A08 | Implemented; live adversarial retest recommended | Procedure retrieval returns citations; unsupported questions return an honest no-answer response. |
| A09 | Implemented; requires rotated credentials and live Noah evidence | Store membership is enforced in chat, API routes, signed audio access, backend checks, and RLS. |
| A10 | Implemented; live restart evidence recommended | Visits/messages/drafts are persisted in Supabase and survive backend restart. |
| A11 | Implemented for the single-backend deployment model | Provider message keys are deduplicated in the database and guarded in-process. |
| A12 | Implemented with heuristic audio protection | Failed/silent audio is marked failed; no transcript or report fact is intentionally invented. |
| A13 | Implemented | An active visit must be cancelled before an explicit store switch; pending notes are scoped to the new visit only. |
| A14 | Implemented | Environment template, migrations, seed, RAG ingestion, user mapping, and runnable checks are documented here. |

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Dashboard shows AUTH_USER_NOT_MAPPED | Auth UUID has not been linked to app_users | Run the two user-mapping SQL updates above, then sign out/in. |
| WhatsApp receives no reply | Backend/ngrok is stopped, or Unipile points to an old tunnel URL | Restart backend and ngrok; update the Unipile webhook URL. |
| Webhook returns 401 | UNIPILE_WEBHOOK_SECRET does not match the configured webhook header/signature | Set the same shared secret in Unipile and .env, then restart backend. |
| Voice note fails | Silent, oversized, unsupported, inaccessible, or transcription service failure | Send a short audible note; the failed message remains visible and text notes are preserved. |
| Dashboard is empty after WhatsApp update | Dashboard does not use realtime subscriptions | Click Refresh data; realtime refresh is intentionally optional. |
| A store card says `Latest validated visit: —` or its button is disabled | The selected store/date filters exclude that store's latest validated visit | Click **Clear filters**, select the store, or set both dates to the visit's local date. For the seeded Nantes record, use `2026-09-04` to `2026-09-04`. |
| RAG returns no answer | The question is outside approved SOP content, or the corpus was not indexed | Run npm run rag:ingest --workspace backend; otherwise the honest unsupported answer is expected. |
| Direct visit/audio URL returns 403 | Current user does not own the unpublished visit or lacks store membership | This is expected access-control behaviour. |

## Known limitations

- Voice protection combines peak/mean audio-volume analysis and conservative transcript heuristics; it is not a full speech-activity model with model confidence scores.
- Audio is limited to two minutes and 10 MB. Run exactly one backend process: startup marks interrupted pending audio as failed so the user can resend it without losing text notes. Multiple replicas require durable worker ownership and additional database concurrency checks.
- Common quantity and quoted corrections are covered by tests. Unusual compound corrections are not universally supported; inspect the revised draft before approval.
- Outbound WhatsApp replies have no durable retry queue. A reply delivery failure can require the user to request the draft again.
- Dependency auditing currently reports advisories in the embedding dependency tree and `qs`. The API uses the simple query parser and does not process images with the embedding library; these mitigations are not equivalent to patched dependencies.
- Photos/OCR, PDF generation, realtime subscriptions, hosted deployment, and additional languages are optional and intentionally out of scope. Browser copy/print provides the required export capability.

See [the latest independent audit](docs/final-audit-2026-09-11.md) for verified results, remaining gaps, and the credential-rotation prerequisite before release.

## Security notes

- The current `.env` is ignored and current `.env.example` contains placeholders. The audit found a Unipile API key in historical `.env.example`; revoke that key and configure a replacement. Deleting a secret from the current file does not remove it from Git history.
- Secret keys stay server-side. The browser uses only the Supabase publishable key.
- Private audio is delivered through short-lived signed URLs after server-side authorisation.
- Real Unipile events fail closed if the webhook secret, account ID, or sender ID is not configured. Configure APP_DASHBOARD_ORIGIN and VITE_API_URL explicitly for any non-local deployment.
- Use development accounts and fictional data only.
