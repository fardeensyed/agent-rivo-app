# Agent Rivo

Agent Rivo is a TypeScript MVP for the field-visit reporting assessment. It turns WhatsApp text and voice inputs into traceable, reviewable, validated visit reports and exposes the same data through an authenticated dashboard.

## Implemented scope

- Typed domain model and visit state machine.
- Replay-safe inbound message ingestion.
- Store/user scope checks.
- Draft versioning and explicit validation guards.
- Local development adapter so the core workflow can be tested before Supabase/Unipile credentials are configured.
- Real Unipile voice-note download, private Supabase Storage, Groq transcription and persisted processing status.
- Supabase Auth login with server-side identity binding and store-scoped dashboard access.
- Procedure RAG over the five supplied Markdown SOPs using local `Supabase/gte-small` embeddings, Supabase pgvector retrieval and citations.
- React + TypeScript dashboard with overview, stores, visits, timeline, reports, filters, transcripts and audio evidence.

## Development

```powershell
npm install
npm run check
npm run test
```

Secrets belong in a local `.env` file. Never commit credentials.

## Supabase Auth setup

The dashboard uses Supabase Auth and maps a verified session to the seeded `app_users` record. The WhatsApp webhook keeps its separate server-controlled identity mapping.

1. In Supabase **Authentication → Users**, create two email/password users (for example `anika@example.test` and `noah@example.test`). For a development-only setup, mark the emails as confirmed.
2. Copy each user's UUID from the Users page.
3. In the SQL editor, bind the UUIDs to the seeded records:

```sql
update public.app_users set auth_user_id = 'ANIKA_AUTH_UUID' where id = 'user_anika';
update public.app_users set auth_user_id = 'NOAH_AUTH_UUID' where id = 'user_noah';
```

4. In the root `.env`, add the public browser configuration (the publishable key is safe for the browser):

```env
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=your_publishable_key
VITE_ENABLE_DEMO_MODE=false
ENABLE_LOCAL_TEST_RUNNER=false
```

Restart both backend and frontend. The login screen will now obtain a Supabase session, and the backend verifies its token before applying store scope.

## Supabase provisioning

Run these SQL migrations in order in Supabase SQL Editor:

1. `supabase/migrations/001_agent_rivo.sql`
2. `supabase/migrations/002_private_voice_storage.sql`
3. `supabase/migrations/003_procedure_chunk_upsert_and_version.sql`
4. `supabase/migrations/004_harden_read_scopes.sql`

Seed the supplied candidate kit. Set `ASSESSMENT_KIT_DIR` to the folder containing `data/`, `procedures/` and `audio/`:

```powershell
$env:ASSESSMENT_KIT_DIR="C:\path\to\agent-rivo-candidate-kit-v2"
npm run seed --workspace backend
npm run rag:ingest --workspace backend
```

The seed and RAG commands require `SUPABASE_URL` and `SUPABASE_SECRET_KEY`. The secret key is server-only.

## Run the app

From the repository root, use either:

```powershell
npm run dev
```

or separate terminals:

```powershell
npm run dev --workspace backend
npm run dev --workspace frontend
```

Open `http://localhost:5173`; the backend listens on `http://localhost:3001`.

For live WhatsApp testing only, keep the backend running and start:

```powershell
ngrok http 3001
```

Configure Unipile with:

```text
https://YOUR-NGROK-DOMAIN.ngrok-free.app/api/webhooks/whatsapp
```

### Webhook authentication

For live Unipile events, the backend verifies either Unipile's `unipile-signature` HMAC header or a static `Unipile-Auth` header against the shared secret. Add the same secret used by the webhook only to the root `.env` file:

```env
UNIPILE_WEBHOOK_SECRET=your_endpoint_secret
```

Restart the backend after adding it. The backend rejects missing, invalid, modified or older-than-five-minute webhook authentication values. Local test-runner events remain available for automated tests and do not require provider authentication.

ngrok is not needed for dashboard-only testing. Send messages from the connected WhatsApp account.

## Verification

```powershell
npm run check
npm run test
npm run test:audit --workspace backend
npm run build --workspace frontend
```

The backend tests cover replay safety, authorization, Unipile payload adaptation, voice completion, corrections, procedure-question separation, pending audio, pre-store notes, store switching and ambiguous removals.

## Demonstration path

1. Sign in as Anika and show the seeded dashboard.
2. Start a Lyon visit through WhatsApp, then send a real voice note and text observation.
3. Ask an equipment procedure question and show its SOP citation.
4. Correct a fact, prepare the draft and validate the latest version explicitly.
5. Refresh the dashboard and show the timeline, transcript, audio and validated report.
6. Sign in as Noah and show that only Lille is accessible.

## Known limits

This is an assessment MVP. Photos/OCR, PDF export, realtime subscriptions and production deployment are optional. Browser print/copy is used for report export. Follow-ups remain report prose; there is no separate task or notification system.

Never include API keys, Supabase secret keys, `.env` files, private audio URLs or production data in the repository.
