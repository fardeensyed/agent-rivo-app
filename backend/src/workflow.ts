import { randomUUID } from "node:crypto";
import { canAccessStore, canMutateVisit, type Message, type User, type Visit, validateDraft } from "./domain.js";
import type { DataRepository } from "./store.js";
import { buildFactualDraft } from "./reporting.js";

export interface UnipileMessageReceivedEvent {
  event: "message_received" | "message.new";
  account_id: string;
  account_type: string;
  chat_id?: string;
  sender?: { attendee_provider_id?: string; attendee_public_identifier?: string };
  message?: string | null;
  message_id?: string;
  provider_message_id?: string;
  timestamp?: string;
  attachments?: Array<{ id?: string; attachment_id?: string; type?: string; url?: string; name?: string; mime_type?: string; mimetype?: string }>;
  is_sender?: boolean;
}

export interface ConversationOutcome {
  ignored?: boolean;
  duplicate?: boolean;
  visit?: Visit;
  reply?: string;
}

export class VisitWorkflow {
  constructor(private readonly db: DataRepository) {}

  async ingestUnipileEvent(event: UnipileMessageReceivedEvent, actorId: string) {
    if (event.is_sender) return { ignored: true, reason: "OUTGOING_MESSAGE" } as const;
    const providerMessageId = event.provider_message_id ?? event.message_id;
    if (!providerMessageId) throw new Error("MISSING_PROVIDER_MESSAGE_ID");
    const attachment = event.attachments?.[0];
    const providerKey = `${event.account_id}:${providerMessageId}`;
    if (attachment && !event.message) {
      return this.ingestAudioPlaceholder({ providerKey, actorId, audioPath: attachment.url, receivedAt: event.timestamp });
    }
    return this.ingestText({ providerKey, actorId, text: event.message ?? "", receivedAt: event.timestamp });
  }

  private async ingestAudioPlaceholder(input: { providerKey: string; actorId: string; audioPath?: string; receivedAt?: string }) {
    const existing = await this.db.getMessageByProviderKey(input.providerKey);
    if (existing) return { duplicate: true, message: existing, visit: existing.visitId ? await this.db.getVisit(existing.visitId) : undefined };
    const user = await this.db.getUser(input.actorId);
    const visit = await this.db.getActiveVisit(user.id);
    const message: Message = {
      id: randomUUID(), providerKey: input.providerKey, actorId: user.id, visitId: visit?.id,
      kind: "audio", audioPath: input.audioPath, processingStatus: "pending", receivedAt: input.receivedAt ?? new Date().toISOString()
    };
    await this.db.insertMessage(message);
    return { duplicate: false, message, visit };
  }

  async ingestText(input: { providerKey: string; actorId: string; text: string; receivedAt?: string }) {
    const existing = await this.db.getMessageByProviderKey(input.providerKey);
    if (existing) return { duplicate: true, message: existing, visit: existing.visitId ? await this.db.getVisit(existing.visitId) : undefined };

    const user = await this.db.getUser(input.actorId);
    const stores = await this.db.getStores();
    const storeMatch = stores.find((store) => input.text.toLowerCase().includes(store.city.toLowerCase()));
    let visit = await this.db.getActiveVisit(user.id);
    const startsVisit = /\bstart\b.*\bvisit\b/i.test(input.text);

    if (startsVisit && storeMatch) {
      if (!canAccessStore(user, storeMatch.id)) throw new Error("FORBIDDEN_STORE");
      if (visit && visit.storeId !== storeMatch.id) throw new Error("ACTIVE_VISIT_REQUIRES_FINISH_OR_CANCEL");
      if (!visit) {
        visit = { id: randomUUID(), storeId: storeMatch.id, authorId: user.id, state: "collecting", startedAt: input.receivedAt ?? new Date().toISOString() };
        await this.db.insertVisit(visit);
      }
    }

    const message: Message = {
      id: randomUUID(), providerKey: input.providerKey, actorId: user.id, visitId: visit?.id,
      kind: /prepare|draft/i.test(input.text) ? "text" : /validate|approve/i.test(input.text) ? "validation" : "text",
      text: input.text, processingStatus: "accepted", receivedAt: input.receivedAt ?? new Date().toISOString()
    };
    await this.db.insertMessage(message);
    return { duplicate: false, message, visit };
  }

  async handleIncomingText(input: { providerKey: string; actorId: string; text: string; receivedAt?: string }): Promise<ConversationOutcome> {
    try {
      const ingested = await this.ingestText(input);
      if (ingested.duplicate) return { duplicate: true, visit: ingested.visit };
      const visit = ingested.visit;
      const user = await this.db.getUser(input.actorId);
      const normalized = input.text.toLowerCase();
      if (!visit) return { reply: "Which authorised store are you visiting? Please choose Lyon or Nantes.", visit };
      if (/\b(cancel|abandon)\b/.test(normalized)) {
        visit.state = "cancelled";
        await this.db.saveVisit(visit);
        return { visit, reply: "The visit was cancelled. You can start a new visit when ready." };
      }
      if (/\b(prepare|show|finish|end)\b.*\b(report|draft|visit)\b/.test(normalized)) {
        const drafted = await this.prepareCurrentDraft(user, visit.id);
        return { visit: drafted, reply: this.formatDraft(drafted) };
      }
      if (/\b(validate|approve)\b/.test(normalized)) {
        if (!visit.draft || visit.state !== "ready_for_review") return { visit, reply: "There is no current draft ready for validation. Ask me to prepare the report first." };
        const validated = await this.validate(user, visit.id, visit.draft.version);
        return { visit: validated, reply: `Report draft ${validated.draft?.version} is validated and final.` };
      }
      if (visit.state === "ready_for_review") {
        const updated = await this.prepareCurrentDraft(user, visit.id);
        return { visit: updated, reply: `I updated the visit with your new information. ${this.formatDraft(updated)}` };
      }
      return { visit, reply: "Recorded. Send another observation, ask a procedure question, or say ‘prepare the report’." };
    } catch (error) {
      if (error instanceof Error && error.message === "ACTIVE_VISIT_REQUIRES_FINISH_OR_CANCEL") {
        return { reply: "You already have an active visit. Please prepare and validate it, or explicitly cancel it before switching stores." };
      }
      if (error instanceof Error && error.message === "FORBIDDEN_STORE") {
        return { reply: "You are not authorised to start a visit for that store." };
      }
      throw error;
    }
  }

  async attachObservation(user: User, visitId: string, text: string, sourceMessageId: string) {
    const visit = await this.db.getVisit(visitId);
    if (!visit || !canMutateVisit(user, visit)) throw new Error("FORBIDDEN");
    if (visit.state !== "collecting") throw new Error("VISIT_NOT_COLLECTING");
    // Source-message association is persisted by the message ingestion adapter.
    return visit;
  }

  async completeAudioMessage(message: Message, transcript: string, audioPath: string): Promise<ConversationOutcome> {
    const completed: Message = {
      ...message,
      audioPath,
      transcript: transcript.trim(),
      processingStatus: "completed",
      processingError: undefined
    };
    await this.db.updateMessage(completed);
    const visit = completed.visitId ? await this.db.getVisit(completed.visitId) : undefined;
    if (!visit) return { reply: `Transcript: “${completed.transcript}”\nStart a visit before sending observations.` };
    if (visit.state === "ready_for_review") {
      const user = await this.db.getUser(completed.actorId);
      const updated = await this.prepareCurrentDraft(user, visit.id);
      return { visit: updated, reply: `Voice note transcribed: “${completed.transcript}”\nI created draft ${updated.draft?.version} because the previous draft is now stale.` };
    }
    return { visit, reply: `Voice note transcribed and recorded: “${completed.transcript}”` };
  }

  async failAudioMessage(message: Message, error: unknown): Promise<void> {
    await this.db.updateMessage({
      ...message,
      processingStatus: "failed",
      processingError: error instanceof Error ? error.message : "VOICE_PROCESSING_FAILED"
    });
  }

  async prepareDraft(user: User, visitId: string, draft: NonNullable<Visit["draft"]>) {
    const visit = await this.db.getVisit(visitId);
    if (!visit || !canMutateVisit(user, visit)) throw new Error("FORBIDDEN");
    visit.draft = draft;
    visit.state = "ready_for_review";
    await this.db.saveVisit(visit);
    return visit;
  }

  async prepareCurrentDraft(user: User, visitId: string) {
    const visit = await this.db.getVisit(visitId);
    if (!visit || !canMutateVisit(user, visit)) throw new Error("FORBIDDEN");
    const store = (await this.db.getStores()).find((item) => item.id === visit.storeId);
    if (!store) throw new Error("STORE_NOT_FOUND");
    const draft = buildFactualDraft(visit, store, await this.db.getVisitMessages(visit.id));
    return this.prepareDraft(user, visit.id, draft);
  }

  async validate(user: User, visitId: string, version: number, now = new Date().toISOString()) {
    const visit = await this.db.getVisit(visitId);
    if (!visit) throw new Error("NOT_FOUND");
    const validated = validateDraft(user, visit, version, now);
    await this.db.saveVisit(validated);
    return validated;
  }

  private formatDraft(visit: Visit): string {
    const draft = visit.draft;
    if (!draft) return "No draft is available yet.";
    const findings = draft.findings.map((finding) => `• ${finding.text}`).join("\n") || "• No observations recorded.";
    const followUps = draft.followUpNotes.length ? `\nFollow-up notes:\n${draft.followUpNotes.map((note) => `• ${note.text}`).join("\n")}` : "";
    return `Draft ${draft.version} — ${draft.title}\n${draft.summary}\n\nFindings:\n${findings}${followUps}\n\nReply ‘I validate the latest draft’ to finalise it, or send a correction.`;
  }
}
