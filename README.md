# Agent Rivo

Agent Rivo is a TypeScript MVP for the field-visit reporting assessment. It turns WhatsApp text and voice inputs into traceable, reviewable, validated visit reports and exposes the same data through an authenticated dashboard.

## Current slice

- Typed domain model and visit state machine.
- Replay-safe inbound message ingestion.
- Store/user scope checks.
- Draft versioning and explicit validation guards.
- Local development adapter so the core workflow can be tested before Supabase/Unipile credentials are configured.
- Real Unipile voice-note download, private Supabase Storage, Groq transcription and persisted processing status.

## Planned integrations

- Supabase Auth and pgvector procedure retrieval.
- Groq report structuring and procedure answers.
- React dashboard.

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
