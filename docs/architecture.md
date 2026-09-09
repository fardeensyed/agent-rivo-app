# Agent Rivo architecture

The application separates channel handling, domain state, AI processing, persistence and presentation.

1. Unipile receives a message and calls the backend webhook.
2. The backend authenticates the provider sender against server-controlled `app_users` mapping.
3. The event is deduplicated using `(provider_account_id, provider_message_id)`.
4. The accepted message is persisted before Groq or any other model call.
5. Text is classified into visit control, observation, correction, validation, or procedure question.
6. Audio is downloaded server-side into private storage, transcribed, and then treated as a traceable message.
7. The report generator receives accepted visit messages only and returns validated structured JSON.
8. A draft is versioned. Validation requires the exact currently displayed version.
9. Dashboard reads are scoped through Supabase Auth/RLS and server-side checks.
10. Procedure questions use pgvector retrieval and return document/section citations.

The model is not the authority for identity, permissions, visit state, validation, or whether a message was processed. Those are deterministic application responsibilities.
