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
