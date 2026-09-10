import { randomUUID } from "node:crypto";
import { canAccessStore, canMutateVisit, type Message, type User, type Visit, validateDraft } from "./domain.js";
import type { DataRepository } from "./store.js";
import { buildFactualDraft, isCorrectionInstruction } from "./reporting.js";
import { isProcedureQuestion } from "./procedures.js";

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

function isAmbiguousCorrection(text: string): boolean {
  if (/\b(?:remove|change|correct|replace)\s+(?:it|that|this)\b/i.test(text)) return true;
  return /^(?:remove|delete)\b/i.test(text)
    && !/\b(?:entrance|stockroom|backroom|tablet|printer|employee|team|boxes|display|delivery|front|signage)\b/i.test(text)
    && !/^\s*(?:remove|delete)\s*:/i.test(text);
}

function isApprovalIntent(text: string): boolean {
  const value = text.trim().toLowerCase();
  if (/\b(?:do not|don't|dont|not|never|without)\s+(?:validate|approve)\b/.test(value)) return false;
  return /^(?:i\s+)?(?:validate|approve)\b/.test(value);
}

function unchangedDraft(left: Visit["draft"], right: Visit["draft"]): boolean {
  if (!left || !right) return false;
  return JSON.stringify({ findings: left.findings, followUpNotes: left.followUpNotes }) === JSON.stringify({ findings: right.findings, followUpNotes: right.followUpNotes });
}

function isAmbiguousDirectCorrection(text: string, visit: Visit): boolean {
  const match = /^(?:change|correct|replace)\s*:?\s+(.+?)\s+(?:to|with)\s+.+?[.!?]?$/i.exec(text.trim());
  if (!match || !visit.draft) return false;
  const needle = match[1].toLowerCase().replace(/\b(?:fifteen|fourteen|thirteen|twelve|eleven|ten|nine|eight|seven|six|five|four|three|two|one|zero)\b/g, (word) => ({ zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10", eleven: "11", twelve: "12", thirteen: "13", fourteen: "14", fifteen: "15" }[word] ?? word));
  const normalise = (value: string) => value.toLowerCase().replace(/\b(?:fifteen|fourteen|thirteen|twelve|eleven|ten|nine|eight|seven|six|five|four|three|two|one|zero)\b/g, (word) => ({ zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10", eleven: "11", twelve: "12", thirteen: "13", fourteen: "14", fifteen: "15" }[word] ?? word));
  return visit.draft.findings.filter((finding) => normalise(finding.text).includes(needle)).length > 1;
}

export class VisitWorkflow {
  private readonly providerLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly db: DataRepository,
    private readonly answerProcedureQuestion: (question: string) => Promise<string> = async () => "Procedure retrieval is not configured yet."
  ) {}

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
    const previous = this.providerLocks.get(input.providerKey);
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.providerLocks.set(input.providerKey, current);
    await previous;
    try {
      return await this.ingestTextUnlocked(input);
    } finally {
      release();
      if (this.providerLocks.get(input.providerKey) === current) this.providerLocks.delete(input.providerKey);
    }
  }

  private async ingestTextUnlocked(input: { providerKey: string; actorId: string; text: string; receivedAt?: string }) {
    const existing = await this.db.getMessageByProviderKey(input.providerKey);
    if (existing) return { duplicate: true, message: existing, visit: existing.visitId ? await this.db.getVisit(existing.visitId) : undefined };

    const user = await this.db.getUser(input.actorId);
    let visit: Visit | undefined;
    let blockedStoreSwitch = false;
    try {
      visit = await this.resolveVisitForInput(user, input.text, input.receivedAt);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "ACTIVE_VISIT_REQUIRES_FINISH_OR_CANCEL") throw error;
      blockedStoreSwitch = true;
      visit = undefined;
    }

    const message: Message = {
      id: randomUUID(), providerKey: input.providerKey, actorId: user.id, visitId: visit?.id,
      kind: isCorrectionInstruction(input.text)
        ? "correction"
        : isProcedureQuestion(input.text)
          ? "procedural_question"
          : isApprovalIntent(input.text)
          ? "validation"
          : "text",
      text: input.text, processingStatus: "accepted", receivedAt: input.receivedAt ?? new Date().toISOString()
    };
    await this.db.insertMessage(message);
    return { duplicate: false, message, visit, blockedStoreSwitch };
  }

  async handleIncomingText(input: { providerKey: string; actorId: string; text: string; receivedAt?: string }): Promise<ConversationOutcome> {
    try {
      const ingested = await this.ingestText(input);
      if (ingested.duplicate) {
        if (ingested.message.kind === "procedural_question") {
          return { duplicate: true, visit: ingested.visit, reply: await this.answerProcedureQuestion(ingested.message.text ?? "") };
        }
        return { duplicate: true, visit: ingested.visit };
      }
      if ("blockedStoreSwitch" in ingested && ingested.blockedStoreSwitch) {
        return { reply: "You already have an active visit. Please validate it, or say ‘Cancel the current visit and start [store]’. I kept the new store note pending and did not attach it to the active visit." };
      }
      const visit = ingested.visit;
      const user = await this.db.getUser(input.actorId);
      const normalized = input.text.toLowerCase();
      if (isProcedureQuestion(input.text)) return { visit, reply: await this.answerProcedureQuestion(input.text) };
      if (!visit) return { reply: "Which authorised store are you visiting? Please choose Lyon or Nantes.", visit };
      const switchesStore = /\b(?:cancel|abandon)\b.*\b(?:start|switch)\b/i.test(input.text);
      if (switchesStore) return { visit, reply: "The previous visit was cancelled and the new store visit was started. I attached the pending observation to this visit without carrying over the previous store’s notes." };
      if (/\b(cancel|abandon)\b/.test(normalized)) {
        visit.state = "cancelled";
        await this.db.saveVisit(visit);
        return { visit, reply: "The visit was cancelled. You can start a new visit when ready." };
      }
      if (/\b(prepare|show|finish|end)\b.*\b(report|draft|visit)\b/.test(normalized)) {
        const drafted = await this.prepareCurrentDraft(user, visit.id);
        return { visit: drafted, reply: this.formatDraft(drafted) };
      }
      if (/\b(?:validate|approve)\b/.test(normalized) && !isApprovalIntent(input.text)) {
        return { visit, reply: "I only validate a report after a clear affirmative approval. Reply ‘I validate the latest draft’ when you are ready." };
      }
      if (isApprovalIntent(input.text)) {
        if (!visit.draft || visit.state !== "ready_for_review") return { visit, reply: "There is no current draft ready for validation. Ask me to prepare the report first." };
        const requestedVersion = /\bdraft\s+(?:version\s+)?(\d+)\b/i.exec(input.text)?.[1];
        if (requestedVersion && Number(requestedVersion) !== visit.draft.version) {
          return { visit, reply: `Draft ${requestedVersion} is outdated and was not validated. The current version is Draft ${visit.draft.version}.\n\n${this.formatDraft(visit)}` };
        }
        const validated = await this.validate(user, visit.id, visit.draft.version);
        return { visit: validated, reply: `Report draft ${validated.draft?.version} is validated and final.` };
      }
      if (isCorrectionInstruction(input.text) && isAmbiguousCorrection(input.text)) {
        return { visit, reply: "Which observation should I change or remove? Reply exactly like: Remove: The entrance is tidy. Or: Change: old text to new text." };
      }
      if (isCorrectionInstruction(input.text) && isAmbiguousDirectCorrection(input.text, visit)) {
        return { visit, reply: "Which matching observation should I change? Please quote the full observation to clarify." };
      }
      if (visit.state === "ready_for_review") {
        const previousDraft = visit.draft;
        const updated = await this.prepareCurrentDraft(user, visit.id);
        const correction = isCorrectionInstruction(input.text);
        if (correction && unchangedDraft(previousDraft, updated.draft)) {
          return { visit, reply: "I could not find one matching observation to change. Please quote the observation exactly, then tell me the replacement if needed." };
        }
        return {
          visit: updated,
          reply: correction
            ? `Correction applied. I created revised draft ${updated.draft?.version}. ${this.formatDraft(updated)}`
            : `I updated the visit with your new information. ${this.formatDraft(updated)}`
        };
      }
      if (isCorrectionInstruction(input.text)) return { visit, reply: "Correction recorded. Ask me to prepare the report when you are ready to review the revised facts." };
      return { visit, reply: "Recorded. Send another observation, ask a procedure question, or say ‘prepare the report’." };
    } catch (error) {
      if (error instanceof Error && error.message === "ACTIVE_VISIT_REQUIRES_FINISH_OR_CANCEL") {
        return { reply: "You already have an active visit. Please prepare and validate it, or explicitly cancel it before switching stores." };
      }
      if (error instanceof Error && error.message === "FORBIDDEN_STORE") {
        return { reply: "You are not authorised to start a visit for that store." };
      }
      if (error instanceof Error && error.message === "PENDING_AUDIO_PROCESSING") {
        return { reply: "I am still transcribing a voice note for this visit. Please wait for the transcription before preparing or validating the report." };
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
    const kind = isProcedureQuestion(transcript)
      ? "procedural_question"
      : isCorrectionInstruction(transcript)
        ? "correction"
        : message.kind;
    const user = await this.db.getUser(message.actorId);
    const attachedVisit = await this.resolveVisitForInput(user, transcript, message.receivedAt, message.visitId);
    const completed: Message = {
      ...message,
      kind,
      visitId: attachedVisit?.id,
      audioPath,
      transcript: transcript.trim(),
      processingStatus: "completed",
      processingError: undefined
    };
    await this.db.updateMessage(completed);
    const visit = attachedVisit;
    if (kind === "procedural_question") return { visit, reply: await this.answerProcedureQuestion(completed.transcript ?? transcript) };
    if (!visit) return { reply: `Transcript: “${completed.transcript}”\nStart a visit before sending observations.` };
    if (kind === "correction" && isAmbiguousCorrection(completed.transcript ?? transcript)) {
      return { visit, reply: "Which observation should I change or remove? Reply exactly like: Remove: The entrance is tidy. Or: Change: old text to new text." };
    }
    if (visit.state === "ready_for_review") {
      const user = await this.db.getUser(completed.actorId);
      const previousDraft = visit.draft;
      const updated = await this.prepareCurrentDraft(user, visit.id);
      const correction = kind === "correction";
      if (correction && unchangedDraft(previousDraft, updated.draft)) {
        return { visit, reply: "I could not find one matching observation to change. Please quote the observation exactly, then tell me the replacement if needed." };
      }
      return {
        visit: updated,
        reply: correction
          ? `Voice correction applied. I created revised draft ${updated.draft?.version}. ${this.formatDraft(updated)}`
          : `Voice note transcribed: “${completed.transcript}”\nI created draft ${updated.draft?.version} because the previous draft is now stale.\n\n${this.formatDraft(updated)}`
      };
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
    if (visit.state === "validated" || visit.state === "cancelled") throw new Error("VISIT_FINAL");
    visit.draft = draft;
    visit.state = "ready_for_review";
    await this.db.saveVisit(visit);
    return visit;
  }

  async prepareCurrentDraft(user: User, visitId: string) {
    const visit = await this.db.getVisit(visitId);
    if (!visit || !canMutateVisit(user, visit)) throw new Error("FORBIDDEN");
    if (visit.state === "validated" || visit.state === "cancelled") throw new Error("VISIT_FINAL");
    const store = (await this.db.getStores()).find((item) => item.id === visit.storeId);
    if (!store) throw new Error("STORE_NOT_FOUND");
    const messages = await this.db.getVisitMessages(visit.id);
    if (messages.some((message) => message.processingStatus === "pending")) throw new Error("PENDING_AUDIO_PROCESSING");
    const draft = buildFactualDraft(visit, store, messages);
    return this.prepareDraft(user, visit.id, draft);
  }

  async validate(user: User, visitId: string, version: number, now = new Date().toISOString()) {
    const visit = await this.db.getVisit(visitId);
    if (!visit) throw new Error("NOT_FOUND");
    if ((await this.db.getVisitMessages(visit.id)).some((message) => message.processingStatus === "pending")) throw new Error("PENDING_AUDIO_PROCESSING");
    const validated = validateDraft(user, visit, version, now);
    await this.db.saveVisit(validated);
    return validated;
  }

  private async resolveVisitForInput(user: User, text: string, receivedAt?: string, existingVisitId?: string): Promise<Visit | undefined> {
    const stores = await this.db.getStores();
    const switchesStore = /\b(?:cancel|abandon)\b.*\b(?:start|switch)\b/i.test(text);
    const switchTarget = switchesStore ? text.slice(Math.max(text.toLowerCase().lastIndexOf("start"), text.toLowerCase().lastIndexOf("switch"))) : text;
    const storeMatch = stores.find((store) => switchTarget.toLowerCase().includes(store.city.toLowerCase()));
    let visit = existingVisitId ? await this.db.getVisit(existingVisitId) : await this.db.getActiveVisit(user.id);
    const startsVisit = /\b(?:start|starting|begin|beginning)\b.*\bvisit\b/i.test(text)
      || /^\s*start\s+(?:a\s+)?(?:lyon|nantes|lille)\b/i.test(text);
    const selectsNamedStore = Boolean(storeMatch && new RegExp(`^\\s*${storeMatch.city}\\s*[.!]?\\s*$`, "i").test(text));
    if (switchesStore && storeMatch && visit && visit.storeId !== storeMatch.id) {
      if (!canAccessStore(user, storeMatch.id)) throw new Error("FORBIDDEN_STORE");
      visit.state = "cancelled";
      await this.db.saveVisit(visit);
      const newVisit: Visit = { id: randomUUID(), storeId: storeMatch.id, authorId: user.id, state: "collecting", startedAt: receivedAt ?? new Date().toISOString() };
      await this.db.insertVisit(newVisit);
      await this.attachRecentUnassignedMessages(user, newVisit, stores);
      return newVisit;
    }
    if ((startsVisit || selectsNamedStore) && storeMatch) {
      if (!canAccessStore(user, storeMatch.id)) throw new Error("FORBIDDEN_STORE");
      if (visit && visit.storeId !== storeMatch.id) throw new Error("ACTIVE_VISIT_REQUIRES_FINISH_OR_CANCEL");
      if (!visit) {
        visit = { id: randomUUID(), storeId: storeMatch.id, authorId: user.id, state: "collecting", startedAt: receivedAt ?? new Date().toISOString() };
        await this.db.insertVisit(visit);
        await this.attachRecentUnassignedMessages(user, visit, stores);
      }
    }
    if (visit && storeMatch && visit.storeId !== storeMatch.id && !isProcedureQuestion(text)) throw new Error("ACTIVE_VISIT_REQUIRES_FINISH_OR_CANCEL");
    return visit;
  }

  private async attachRecentUnassignedMessages(user: User, visit: Visit, stores: Awaited<ReturnType<DataRepository["getStores"]>>): Promise<void> {
    const visitStart = Date.parse(visit.startedAt);
    const unassigned = await this.db.getUnassignedMessagesForUser(user.id);
    for (const message of unassigned) {
      if (message.kind !== "text" && message.kind !== "audio") continue;
      const value = (message.transcript ?? message.text ?? "").trim();
      const age = visitStart - Date.parse(message.receivedAt);
      if (!Number.isFinite(age) || age < 0 || age > 30 * 60 * 1000) continue;
      if (/^(?:lyon|nantes|lille)[.!]?$/i.test(value) || /\b(?:start|prepare|show|finish|end|cancel|abandon|validate|approve)\b/i.test(value)) continue;
      const mentionedStore = stores.find((store) => value.toLowerCase().includes(store.city.toLowerCase()));
      if (mentionedStore && mentionedStore.id !== visit.storeId) continue;
      await this.db.updateMessage({ ...message, visitId: visit.id });
    }
  }

  private formatDraft(visit: Visit): string {
    const draft = visit.draft;
    if (!draft) return "No draft is available yet.";
    const findings = draft.findings.map((finding) => `• ${finding.text}`).join("\n") || "• No observations recorded.";
    const followUps = draft.followUpNotes.length ? `\nFollow-up notes:\n${draft.followUpNotes.map((note) => `• ${note.text}`).join("\n")}` : "";
    return `Draft ${draft.version} — ${draft.title}\n${draft.summary}\n\nFindings:\n${findings}${followUps}\n\nReply ‘I validate the latest draft’ to finalise it, or send a correction.`;
  }
}
