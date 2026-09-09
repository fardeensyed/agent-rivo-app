import { randomUUID } from "node:crypto";
import { canAccessStore, canMutateVisit, type Message, type User, type Visit, validateDraft } from "./domain.js";
import { MemoryStore } from "./store.js";

export interface UnipileMessageReceivedEvent {
  event: "message_received" | "message.new";
  account_id: string;
  account_type: string;
  sender?: { attendee_provider_id?: string; attendee_public_identifier?: string };
  message?: string | null;
  message_id?: string;
  provider_message_id?: string;
  timestamp?: string;
  attachments?: Array<{ type?: string; url?: string; name?: string; mime_type?: string }>;
  is_sender?: boolean;
}

export class VisitWorkflow {
  constructor(private readonly db: MemoryStore) {}

  ingestUnipileEvent(event: UnipileMessageReceivedEvent, actorId: string) {
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

  private ingestAudioPlaceholder(input: { providerKey: string; actorId: string; audioPath?: string; receivedAt?: string }) {
    const existing = this.db.messageByProviderKey(input.providerKey);
    if (existing) return { duplicate: true, message: existing, visit: existing.visitId ? this.db.visits.find((v) => v.id === existing.visitId) : undefined };
    const user = this.db.user(input.actorId);
    const visit = this.db.activeVisit(user.id);
    const message: Message = {
      id: randomUUID(), providerKey: input.providerKey, actorId: user.id, visitId: visit?.id,
      kind: "audio", audioPath: input.audioPath, processingStatus: "pending", receivedAt: input.receivedAt ?? new Date().toISOString()
    };
    this.db.messages.push(message);
    return { duplicate: false, message, visit };
  }

  ingestText(input: { providerKey: string; actorId: string; text: string; receivedAt?: string }) {
    const existing = this.db.messageByProviderKey(input.providerKey);
    if (existing) return { duplicate: true, message: existing, visit: existing.visitId ? this.db.visits.find((v) => v.id === existing.visitId) : undefined };

    const user = this.db.user(input.actorId);
    const storeMatch = this.db.stores.find((store) => input.text.toLowerCase().includes(store.city.toLowerCase()));
    let visit = this.db.activeVisit(user.id);
    const startsVisit = /\bstart\b.*\bvisit\b/i.test(input.text);

    if (startsVisit && storeMatch) {
      if (!canAccessStore(user, storeMatch.id)) throw new Error("FORBIDDEN_STORE");
      if (visit && visit.storeId !== storeMatch.id) throw new Error("ACTIVE_VISIT_REQUIRES_FINISH_OR_CANCEL");
      if (!visit) {
        visit = { id: randomUUID(), storeId: storeMatch.id, authorId: user.id, state: "collecting", startedAt: input.receivedAt ?? new Date().toISOString() };
        this.db.visits.push(visit);
      }
    }

    const message: Message = {
      id: randomUUID(), providerKey: input.providerKey, actorId: user.id, visitId: visit?.id,
      kind: /prepare|draft/i.test(input.text) ? "text" : /validate|approve/i.test(input.text) ? "validation" : "text",
      text: input.text, processingStatus: "accepted", receivedAt: input.receivedAt ?? new Date().toISOString()
    };
    this.db.messages.push(message);
    return { duplicate: false, message, visit };
  }

  attachObservation(user: User, visitId: string, text: string, sourceMessageId: string) {
    const visit = this.db.visits.find((item) => item.id === visitId);
    if (!visit || !canMutateVisit(user, visit)) throw new Error("FORBIDDEN");
    if (visit.state !== "collecting") throw new Error("VISIT_NOT_COLLECTING");
    const message = this.db.messages.find((item) => item.id === sourceMessageId);
    if (message) message.visitId = visit.id;
    return visit;
  }

  prepareDraft(user: User, visitId: string, draft: NonNullable<Visit["draft"]>) {
    const visit = this.db.visits.find((item) => item.id === visitId);
    if (!visit || !canMutateVisit(user, visit)) throw new Error("FORBIDDEN");
    visit.draft = draft;
    visit.state = "ready_for_review";
    return visit;
  }

  validate(user: User, visitId: string, version: number, now = new Date().toISOString()) {
    const visit = this.db.visits.find((item) => item.id === visitId);
    if (!visit) throw new Error("NOT_FOUND");
    return validateDraft(user, visit, version, now);
  }
}
