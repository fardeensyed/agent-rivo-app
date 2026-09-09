import cors from "cors";
import express from "express";
import { z } from "zod";
import { MemoryStore } from "./store.js";
import { VisitWorkflow, type UnipileMessageReceivedEvent } from "./workflow.js";
import { config } from "./config.js";
import { SupabaseStore } from "./supabase-store.js";
import { createPrivateVoiceNoteUrl, createSupabaseAdmin, downloadUnipileAttachment, sendUnipileText, storePrivateVoiceNote, transcribeAudio } from "./integrations.js";
import { ProcedureAssistant } from "./procedures.js";

const app = express();
const supabaseAdmin = createSupabaseAdmin();
const db = supabaseAdmin ? new SupabaseStore(supabaseAdmin) : new MemoryStore();
const procedureAssistant = supabaseAdmin ? new ProcedureAssistant(supabaseAdmin) : undefined;
const workflow = new VisitWorkflow(db, (question) => procedureAssistant?.answer(question) ?? Promise.resolve("Procedure retrieval is not configured yet."));
app.use(cors());
app.use(express.json());

const actor = (request: express.Request) => db.getUser(String(request.header("x-demo-user") || "user_anika"));

async function replyIfPossible(chatId: string | undefined, text: string): Promise<void> {
  if (!chatId) return;
  try { await sendUnipileText(chatId, text); }
  catch (replyError) { console.error("UNIPILE_FALLBACK_REPLY_FAILED", replyError instanceof Error ? replyError.message : "UNKNOWN"); }
}

app.get("/health", (_request, response) => response.json({ ok: true, service: "agent-rivo-backend" }));

app.get("/api/stores", async (request, response) => {
  const user = await actor(request);
  const stores = await db.getStores();
  response.json(stores.filter((store) => user.storeIds.includes(store.id)));
});

app.get("/api/visits", async (request, response) => {
  const user = await actor(request);
  response.json(await db.getVisibleVisits(user));
});

app.post("/api/webhooks/whatsapp", async (request, response) => {
  const testEvent = z.object({ providerKey: z.string(), actorId: z.string(), text: z.string(), receivedAt: z.string().optional() }).safeParse(request.body);
  const unipileEvent = z.object({
    event: z.enum(["message_received", "message.new"]), account_id: z.string(), account_type: z.string(), chat_id: z.string().optional(),
    sender: z.object({ attendee_provider_id: z.string().optional(), attendee_public_identifier: z.string().optional() }).optional(),
    message: z.string().nullable().optional(), message_id: z.string().optional(), provider_message_id: z.string().optional(),
    timestamp: z.string().optional(), attachments: z.array(z.object({ id: z.string().optional(), attachment_id: z.string().optional(), type: z.string().optional(), url: z.string().optional(), name: z.string().optional(), mime_type: z.string().optional(), mimetype: z.string().optional() })).optional(),
    is_sender: z.boolean().optional()
  }).safeParse(request.body);
  if (!testEvent.success && !unipileEvent.success) return response.status(400).json({ error: "INVALID_EVENT" });
  try {
    if (testEvent.success) return response.status(202).json(await workflow.handleIncomingText(testEvent.data));
    if (!unipileEvent.success) return response.status(400).json({ error: "INVALID_EVENT" });
    const event = unipileEvent.data;
    // Unipile also posts events for messages that the assistant itself sends.
    // Ignore those before checking the human-sender allow-list.
    if (event.is_sender) return response.status(202).json({ ignored: true, reason: "OUTGOING_MESSAGE" });
    if (config.unipileAccountId && event.account_id !== config.unipileAccountId) return response.status(403).json({ error: "UNKNOWN_UNIPILE_ACCOUNT" });
    const senderId = event.sender?.attendee_provider_id ?? event.sender?.attendee_public_identifier;
    if (config.unipileSenderId && senderId !== config.unipileSenderId) return response.status(403).json({ error: "UNKNOWN_WHATSAPP_SENDER" });
    const providerMessageId = event.provider_message_id ?? event.message_id;
    if (!providerMessageId) return response.status(400).json({ error: "MISSING_PROVIDER_MESSAGE_ID" });
    if (event.attachments?.length && !event.message) {
      const outcome = await workflow.ingestUnipileEvent(event as UnipileMessageReceivedEvent, config.unipileActorId);
      if ("duplicate" in outcome && outcome.duplicate) return response.status(202).json(outcome);
      if (!("message" in outcome) || !outcome.message) return response.status(202).json(outcome);
      try {
        const attachment = event.attachments[0];
        const attachmentId = attachment.id ?? attachment.attachment_id;
        if (!event.message_id || !attachmentId) {
          throw new Error(`VOICE_ATTACHMENT_IDENTIFIERS_MISSING:message_id=${Boolean(event.message_id)},attachment_id=${Boolean(attachmentId)}`);
        }
        const downloaded = await downloadUnipileAttachment(event.message_id, attachmentId);
        const contentType = attachment.mimetype ?? attachment.mime_type ?? downloaded.contentType;
        const extension = contentType.includes("mpeg") ? "mp3" : contentType.includes("mp4") ? "m4a" : contentType.includes("webm") ? "webm" : contentType.includes("wav") ? "wav" : "ogg";
        const storagePath = `${outcome.message.visitId ?? "unassigned"}/${outcome.message.id}.${extension}`;
        await storePrivateVoiceNote(storagePath, downloaded.bytes, contentType);
        const transcript = await transcribeAudio(downloaded.bytes, attachment.name ?? `voice-note.${extension}`);
        const completed = await workflow.completeAudioMessage(outcome.message, transcript, storagePath);
        if (event.chat_id && completed.reply) await sendUnipileText(event.chat_id, completed.reply);
        return response.status(202).json({ ...completed, message: { ...outcome.message, audioPath: storagePath, transcript, processingStatus: "completed" } });
      } catch (voiceError) {
        await workflow.failAudioMessage(outcome.message, voiceError);
        console.error("VOICE_PROCESSING_FAILED", voiceError instanceof Error ? voiceError.message : "UNKNOWN");
        if (event.chat_id) {
          try { await sendUnipileText(event.chat_id, "I received the voice note but could not transcribe it. Please resend it or send the observation as text."); }
          catch { /* The inbound event is still durably recorded as failed. */ }
        }
        return response.status(202).json({ accepted: true, voiceProcessing: "failed" });
      }
    }
    const outcome = await workflow.handleIncomingText({ providerKey: `${event.account_id}:${providerMessageId}`, actorId: config.unipileActorId, text: event.message ?? "", receivedAt: event.timestamp });
    if (event.chat_id && outcome.reply) await replyIfPossible(event.chat_id, outcome.reply);
    return response.status(202).json(outcome);
  }
  catch (error) {
    console.error("WEBHOOK_PROCESSING_FAILED", error instanceof Error ? error.message : "UNKNOWN");
    if (unipileEvent.success) {
      await replyIfPossible(unipileEvent.data.chat_id, "I could not complete that request right now. Please try again in a moment. Your previous visit notes were preserved.");
      return response.status(202).json({ accepted: true, processing: "failed" });
    }
    return response.status(400).json({ error: error instanceof Error ? error.message : "INGEST_FAILED" });
  }
});

app.get("/api/messages/:messageId/audio-url", async (request, response) => {
  try {
    const user = await actor(request);
    const message = await db.getMessage(request.params.messageId);
    if (!message?.visitId || !message.audioPath) return response.status(404).json({ error: "AUDIO_NOT_FOUND" });
    const visit = await db.getVisit(message.visitId);
    if (!visit || !user.storeIds.includes(visit.storeId)) return response.status(403).json({ error: "FORBIDDEN" });
    return response.json({ url: await createPrivateVoiceNoteUrl(message.audioPath), expiresIn: 300 });
  } catch (error) {
    return response.status(400).json({ error: error instanceof Error ? error.message : "AUDIO_URL_FAILED" });
  }
});

app.post("/api/visits/:visitId/validate", async (request, response) => {
  try {
    const version = z.object({ version: z.number().int().positive() }).parse(request.body).version;
    return response.json(await workflow.validate(await actor(request), request.params.visitId, version));
  } catch (error) { return response.status(400).json({ error: error instanceof Error ? error.message : "VALIDATION_FAILED" }); }
});

app.post("/api/visits/:visitId/draft", async (request, response) => {
  try { return response.json(await workflow.prepareCurrentDraft(await actor(request), request.params.visitId)); }
  catch (error) { return response.status(400).json({ error: error instanceof Error ? error.message : "DRAFT_FAILED" }); }
});

const port = Number(process.env.PORT || 3001);
app.listen(port, () => console.log(`Agent Rivo backend listening on http://localhost:${port}`));
