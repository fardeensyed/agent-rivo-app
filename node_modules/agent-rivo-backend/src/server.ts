import "dotenv/config";
import cors from "cors";
import express from "express";
import { z } from "zod";
import { MemoryStore } from "./store.js";
import { VisitWorkflow, type UnipileMessageReceivedEvent } from "./workflow.js";
import { config } from "./config.js";

const app = express();
const db = new MemoryStore();
const workflow = new VisitWorkflow(db);
app.use(cors());
app.use(express.json());

const actor = (request: express.Request) => db.user(String(request.header("x-demo-user") || "user_anika"));

app.get("/health", (_request, response) => response.json({ ok: true, service: "agent-rivo-backend" }));

app.get("/api/stores", (request, response) => {
  const user = actor(request);
  response.json(db.stores.filter((store) => user.storeIds.includes(store.id)));
});

app.get("/api/visits", (request, response) => {
  const user = actor(request);
  response.json(db.visits.filter((visit) => visit.authorId === user.id || user.storeIds.includes(visit.storeId)));
});

app.post("/api/webhooks/whatsapp", (request, response) => {
  const testEvent = z.object({ providerKey: z.string(), actorId: z.string(), text: z.string(), receivedAt: z.string().optional() }).safeParse(request.body);
  const unipileEvent = z.object({
    event: z.enum(["message_received", "message.new"]), account_id: z.string(), account_type: z.string(),
    sender: z.object({ attendee_provider_id: z.string().optional(), attendee_public_identifier: z.string().optional() }).optional(),
    message: z.string().nullable().optional(), message_id: z.string().optional(), provider_message_id: z.string().optional(),
    timestamp: z.string().optional(), attachments: z.array(z.object({ type: z.string().optional(), url: z.string().optional(), name: z.string().optional(), mime_type: z.string().optional() })).optional(),
    is_sender: z.boolean().optional()
  }).safeParse(request.body);
  if (!testEvent.success && !unipileEvent.success) return response.status(400).json({ error: "INVALID_EVENT" });
  try {
    if (testEvent.success) return response.status(202).json(workflow.ingestText(testEvent.data));
    if (!unipileEvent.success) return response.status(400).json({ error: "INVALID_EVENT" });
    const event = unipileEvent.data;
    if (config.unipileAccountId && event.account_id !== config.unipileAccountId) return response.status(403).json({ error: "UNKNOWN_UNIPILE_ACCOUNT" });
    const senderId = event.sender?.attendee_provider_id ?? event.sender?.attendee_public_identifier;
    if (config.unipileSenderId && senderId !== config.unipileSenderId) return response.status(403).json({ error: "UNKNOWN_WHATSAPP_SENDER" });
    return response.status(202).json(workflow.ingestUnipileEvent(event as UnipileMessageReceivedEvent, config.unipileActorId));
  }
  catch (error) { return response.status(400).json({ error: error instanceof Error ? error.message : "INGEST_FAILED" }); }
});

app.post("/api/visits/:visitId/validate", (request, response) => {
  try {
    const version = z.object({ version: z.number().int().positive() }).parse(request.body).version;
    return response.json(workflow.validate(actor(request), request.params.visitId, version));
  } catch (error) { return response.status(400).json({ error: error instanceof Error ? error.message : "VALIDATION_FAILED" }); }
});

const port = Number(process.env.PORT || 3001);
app.listen(port, () => console.log(`Agent Rivo backend listening on http://localhost:${port}`));
