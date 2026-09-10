import test from "node:test";
import assert from "node:assert/strict";
import { audioAppearsSilent, requireReliableTranscript } from "../src/integrations.js";
import { MemoryStore } from "../src/store.js";
import { VisitWorkflow } from "../src/workflow.js";
import { isUnsupportedProcedureAnswer, selectRelevantProcedureChunks } from "../src/procedures.js";

test("replaying a provider event has one effect", async () => {
  const db = new MemoryStore();
  const workflow = new VisitWorkflow(db);
  const event = { providerKey: "provider-1", actorId: "user_anika", text: "Start a visit to Lyon.", receivedAt: "2026-09-07T10:01:00+02:00" };
  assert.equal((await workflow.ingestText(event)).duplicate, false);
  assert.equal((await workflow.ingestText(event)).duplicate, true);
  assert.equal(db.visits.length, 1);
  assert.equal(db.messages.length, 1);
});

test("rejects empty and obvious silence hallucinations from voice transcription", () => {
  assert.throws(() => requireReliableTranscript("you"), /VOICE_TRANSCRIPT_UNRELIABLE/);
  assert.throws(() => requireReliableTranscript("Thank you."), /VOICE_TRANSCRIPT_UNRELIABLE/);
  assert.throws(() => requireReliableTranscript("   "), /VOICE_TRANSCRIPT_UNRELIABLE/);
  assert.equal(requireReliableTranscript("The entrance is tidy."), "The entrance is tidy.");
});

test("recognises an FFmpeg near-silence measurement before transcription", () => {
  assert.equal(audioAppearsSilent("max_volume: -67.4 dB"), true);
  assert.equal(audioAppearsSilent("max_volume: -18.2 dB"), false);
  assert.equal(audioAppearsSilent("max_volume: -inf dB"), true);
});

test("does not cite low-similarity SOP chunks for unsupported questions", () => {
  const relevant = selectRelevantProcedureChunks([
    { documentId: "SOP-02", title: "Stockroom", section: "Delivery", version: "1.0", content: "Delivery facts.", similarity: 0.42 },
    { documentId: "SOP-03", title: "Equipment", section: "Information to collect", version: "1.0", content: "Equipment facts.", similarity: 0.81 }
  ]);
  assert.deepEqual(relevant.map((chunk) => chunk.documentId), ["SOP-03"]);
  assert.equal(isUnsupportedProcedureAnswer("The store tax rate is not specified in the provided excerpts."), true);
  assert.equal(isUnsupportedProcedureAnswer("Record the observed equipment symptom."), false);
});

test("validation requires the current draft version", async () => {
  const db = new MemoryStore();
  const workflow = new VisitWorkflow(db);
  const { visit } = await workflow.ingestText({ providerKey: "provider-2", actorId: "user_anika", text: "Start a visit to Lyon." });
  assert.ok(visit);
  const user = await db.getUser("user_anika");
  await workflow.prepareDraft(user, visit!.id, { version: 2, title: "Lyon report", summary: "Observed facts only.", findings: [], followUpNotes: [], sourceMessageIds: [] });
  await assert.rejects(() => workflow.validate(user, visit!.id, 1), /STALE_DRAFT/);
  assert.equal((await workflow.validate(user, visit!.id, 2)).state, "validated");
});

test("a user cannot start an unauthorised store visit", async () => {
  const workflow = new VisitWorkflow(new MemoryStore());
  await assert.rejects(() => workflow.ingestText({ providerKey: "provider-3", actorId: "user_noah", text: "Start a visit to Lyon." }), /FORBIDDEN_STORE/);
});

test("adapts the real Unipile message_received shape", async () => {
  const db = new MemoryStore();
  const workflow = new VisitWorkflow(db);
  const result = await workflow.ingestUnipileEvent({
    event: "message_received", account_id: "account-1", account_type: "WHATSAPP",
    sender: { attendee_provider_id: "sender-1" }, message: "Start a visit to Lyon.",
    message_id: "internal-1", provider_message_id: "provider-1", timestamp: "2026-09-08T23:21:45.000Z", attachments: [], is_sender: false
  }, "user_anika");
  assert.equal("ignored" in result, false);
  if ("ignored" in result) return;
  assert.equal(result.duplicate, false);
  assert.equal(result.visit?.storeId, "store_lyon");
  assert.equal(db.messages[0]?.providerKey, "account-1:provider-1");
});

test("builds a factual versioned draft from accepted messages", async () => {
  const db = new MemoryStore();
  const workflow = new VisitWorkflow(db);
  const user = await db.getUser("user_anika");
  const started = await workflow.ingestText({ providerKey: "provider-4", actorId: user.id, text: "Start a visit to Lyon." });
  await workflow.ingestText({ providerKey: "provider-5", actorId: user.id, text: "The front display is tidy. Five boxes are outside storage." });
  const draftVisit = await workflow.prepareCurrentDraft(user, started.visit!.id);
  assert.equal(draftVisit.state, "ready_for_review");
  assert.equal(draftVisit.draft?.version, 1);
  assert.equal(draftVisit.draft?.findings.length, 2);
  assert.match(draftVisit.draft?.summary ?? "", /front display is tidy/i);
});

test("does not include standalone visit commands in a draft", async () => {
  const db = new MemoryStore();
  const workflow = new VisitWorkflow(db);
  const user = await db.getUser("user_anika");
  const started = await workflow.ingestText({ providerKey: "provider-6", actorId: user.id, text: "Start a visit to Lyon." });
  await workflow.ingestText({ providerKey: "provider-7", actorId: user.id, text: "finish" });
  await workflow.ingestText({ providerKey: "provider-8", actorId: user.id, text: "The entrance is tidy." });
  const drafted = await workflow.prepareCurrentDraft(user, started.visit!.id);
  assert.deepEqual(drafted.draft?.findings.map((finding) => finding.text), ["The entrance is tidy."]);
});

test("applies a quantity correction and preserves the audit trail in a revised draft", async () => {
  const db = new MemoryStore();
  const workflow = new VisitWorkflow(db);
  const user = await db.getUser("user_anika");
  const started = await workflow.ingestText({ providerKey: "provider-correction-start", actorId: user.id, text: "Start a visit to Lyon." });
  const original = await workflow.ingestText({ providerKey: "provider-correction-observation", actorId: user.id, text: "Fifteen boxes are outside storage." });
  const firstDraft = await workflow.prepareCurrentDraft(user, started.visit!.id);
  assert.equal(firstDraft.draft?.version, 1);

  const corrected = await workflow.handleIncomingText({ providerKey: "provider-correction-change", actorId: user.id, text: "Change fifteen boxes to five." });
  assert.equal(corrected.visit?.draft?.version, 2);
  assert.deepEqual(corrected.visit?.draft?.findings.map((finding) => finding.text), ["five boxes are outside storage."]);
  assert.deepEqual(corrected.visit?.draft?.findings[0]?.sourceMessageIds, [original.message.id, db.messages[2]!.id]);
  assert.match(corrected.reply ?? "", /Correction applied/i);
});

test("answers a procedure question without adding it as a visit finding", async () => {
  const db = new MemoryStore();
  const workflow = new VisitWorkflow(db, async () => "Record the observed equipment symptom.\n\nSources:\n• SOP-03: Information to collect");
  const user = await db.getUser("user_anika");
  const started = await workflow.ingestText({ providerKey: "provider-procedure-start", actorId: user.id, text: "Start a visit to Lyon." });
  const outcome = await workflow.handleIncomingText({ providerKey: "provider-procedure-question", actorId: user.id, text: "What should I record for an equipment incident?" });
  assert.match(outcome.reply ?? "", /SOP-03/);
  assert.equal(db.messages.at(-1)?.kind, "procedural_question");
  const draft = await workflow.prepareCurrentDraft(user, started.visit!.id);
  assert.equal(draft.draft?.findings.length, 0);
  assert.equal(draft.draft?.followUpNotes.length, 0);
});

test("does not turn cancel into a report finding", async () => {
  const db = new MemoryStore();
  const workflow = new VisitWorkflow(db);
  const user = await db.getUser("user_anika");
  const started = await workflow.ingestText({ providerKey: "cancel-start", actorId: user.id, text: "Start a visit to Lyon." });
  await workflow.ingestText({ providerKey: "cancel-note", actorId: user.id, text: "The entrance is tidy." });
  await workflow.handleIncomingText({ providerKey: "cancel-command", actorId: user.id, text: "cancel" });
  const drafted = await workflow.prepareCurrentDraft(user, started.visit!.id);
  assert.deepEqual(drafted.draft?.findings.map((finding) => finding.text), ["The entrance is tidy."]);
});

test("completes a voice note and uses its transcript as a factual observation", async () => {
  const db = new MemoryStore();
  const workflow = new VisitWorkflow(db);
  const started = await workflow.ingestText({ providerKey: "provider-9", actorId: "user_anika", text: "Start a visit to Lyon." });
  const pending = await workflow.ingestUnipileEvent({
    event: "message_received", account_id: "account-1", account_type: "WHATSAPP", message_id: "unipile-message-1",
    provider_message_id: "provider-10", attachments: [{ id: "attachment-1", type: "audio", mimetype: "audio/ogg" }]
  }, "user_anika");
  assert.equal("message" in pending && pending.message.processingStatus, "pending");
  if (!("message" in pending)) return;
  await workflow.completeAudioMessage(pending.message, "The delivery area is clean.", `${started.visit!.id}/${pending.message.id}.ogg`);
  const user = await db.getUser("user_anika");
  const drafted = await workflow.prepareCurrentDraft(user, started.visit!.id);
  assert.deepEqual(drafted.draft?.findings.map((finding) => finding.text), ["The delivery area is clean."]);
  assert.equal(db.messages[1]?.processingStatus, "completed");
});

test("starts a visit from a voice transcript and keeps every spoken observation", async () => {
  const db = new MemoryStore();
  const workflow = new VisitWorkflow(db);
  const pending = await workflow.ingestUnipileEvent({
    event: "message_received", account_id: "account-1", account_type: "WHATSAPP", message_id: "voice-start-message",
    provider_message_id: "voice-start-provider", attachments: [{ id: "voice-start-attachment", type: "audio" }]
  }, "user_anika");
  if (!("message" in pending)) return;
  const completed = await workflow.completeAudioMessage(pending.message, "I am starting a visit to Nantes. Two promotional labels are missing. One team member is absent today.", "store_nantes/voice.ogg");
  assert.equal(completed.visit?.storeId, "store_nantes");
  const user = await db.getUser("user_anika");
  const drafted = await workflow.prepareCurrentDraft(user, completed.visit!.id);
  assert.deepEqual(drafted.draft?.findings.map((finding) => finding.text), ["Two promotional labels are missing.", "One team member is absent today."]);
});

test("applies a natural spoken quantity correction", async () => {
  const db = new MemoryStore();
  const workflow = new VisitWorkflow(db);
  const user = await db.getUser("user_anika");
  const started = await workflow.ingestText({ providerKey: "spoken-correction-start", actorId: user.id, text: "Start a visit to Lyon." });
  await workflow.ingestText({ providerKey: "spoken-correction-original", actorId: user.id, text: "Fifteen boxes are outside the storage area." });
  await workflow.ingestText({ providerKey: "spoken-correction-change", actorId: user.id, text: "Correction to my previous note. There are five boxes outside the storage area, not fifteen. Please use five in the report." });
  const drafted = await workflow.prepareCurrentDraft(user, started.visit!.id);
  assert.deepEqual(drafted.draft?.findings.map((finding) => finding.text), ["five boxes are outside the storage area."]);
  assert.equal(drafted.draft?.findings[0]?.sourceMessageIds.length, 2);
});

test("matches spoken number words to digit transcriptions", async () => {
  const db = new MemoryStore();
  const workflow = new VisitWorkflow(db);
  const user = await db.getUser("user_anika");
  const started = await workflow.ingestText({ providerKey: "digit-correction-start", actorId: user.id, text: "Start a visit to Lyon." });
  await workflow.ingestText({ providerKey: "digit-correction-original", actorId: user.id, text: "There are 15 boxes outside storage." });
  await workflow.ingestText({ providerKey: "digit-correction-change", actorId: user.id, text: "Change fifteen boxes to five." });
  const drafted = await workflow.prepareCurrentDraft(user, started.visit!.id);
  assert.deepEqual(drafted.draft?.findings.map((finding) => finding.text), ["There are five boxes outside storage."]);
});

test("holds a cross-store note and moves it only after an explicit cancel-and-switch", async () => {
  const db = new MemoryStore();
  const workflow = new VisitWorkflow(db);
  const lyon = await workflow.ingestText({ providerKey: "switch-start", actorId: "user_anika", text: "Start a visit to Lyon." });
  await workflow.ingestText({ providerKey: "switch-lyon-note", actorId: "user_anika", text: "There are boxes outside storage." });
  const blocked = await workflow.handleIncomingText({ providerKey: "switch-other-store", actorId: "user_anika", text: "Now I am at Nantes. The entrance is tidy." });
  assert.match(blocked.reply ?? "", /kept the new store note pending/i);
  assert.equal(db.messages.at(-1)?.visitId, undefined);
  const switched = await workflow.handleIncomingText({ providerKey: "switch-confirm", actorId: "user_anika", text: "Cancel the Lyon draft and start Nantes." });
  assert.equal(switched.visit?.storeId, "store_nantes");
  assert.equal((await db.getVisit(lyon.visit!.id))?.state, "cancelled");
  const user = await db.getUser("user_anika");
  const drafted = await workflow.prepareCurrentDraft(user, switched.visit!.id);
  assert.deepEqual(drafted.draft?.findings.map((finding) => finding.text), ["The entrance is tidy."]);
});

test("rejects approval of an explicitly outdated draft version", async () => {
  const db = new MemoryStore();
  const workflow = new VisitWorkflow(db);
  const started = await workflow.ingestText({ providerKey: "stale-start", actorId: "user_anika", text: "Start a visit to Lyon." });
  await workflow.ingestText({ providerKey: "stale-note", actorId: "user_anika", text: "There are fifteen boxes outside storage." });
  const user = await db.getUser("user_anika");
  await workflow.prepareCurrentDraft(user, started.visit!.id);
  const corrected = await workflow.handleIncomingText({ providerKey: "stale-correction", actorId: "user_anika", text: "Change fifteen boxes to five." });
  assert.equal(corrected.visit?.draft?.version, 2);
  const rejected = await workflow.handleIncomingText({ providerKey: "stale-approval", actorId: "user_anika", text: "I validate report draft 1." });
  assert.match(rejected.reply ?? "", /Draft 1 is outdated and was not validated/i);
  assert.equal(rejected.visit?.state, "ready_for_review");
  const validated = await workflow.handleIncomingText({ providerKey: "current-approval", actorId: "user_anika", text: "I validate report draft 2." });
  assert.equal(validated.visit?.state, "validated");
  assert.equal(validated.visit?.draft?.version, 2);
});

test("keeps an observation sent before store selection and attaches it after an explicit visit start", async () => {
  const db = new MemoryStore();
  const workflow = new VisitWorkflow(db);
  await workflow.handleIncomingText({ providerKey: "pending-store-note", actorId: "user_anika", text: "The entrance is tidy." });
  assert.equal(db.messages[0]?.visitId, undefined);
  const started = await workflow.ingestText({ providerKey: "pending-store-start", actorId: "user_anika", text: "Start a visit to Lyon." });
  const user = await db.getUser("user_anika");
  const drafted = await workflow.prepareCurrentDraft(user, started.visit!.id);
  assert.deepEqual(drafted.draft?.findings.map((finding) => finding.text), ["The entrance is tidy."]);
});

test("does not prepare a report while a visit voice note is still transcribing", async () => {
  const db = new MemoryStore();
  const workflow = new VisitWorkflow(db);
  const started = await workflow.ingestText({ providerKey: "pending-audio-start", actorId: "user_anika", text: "Start a visit to Lyon." });
  await workflow.ingestUnipileEvent({
    event: "message_received", account_id: "account-1", account_type: "WHATSAPP", message_id: "pending-audio-message",
    provider_message_id: "pending-audio-provider", attachments: [{ id: "pending-audio-attachment", type: "audio" }]
  }, "user_anika");
  const outcome = await workflow.handleIncomingText({ providerKey: "pending-audio-prepare", actorId: "user_anika", text: "Prepare the report." });
  assert.match(outcome.reply ?? "", /still transcribing/i);
  assert.equal((await db.getActiveVisit("user_anika"))?.draft, undefined);
});

test("asks for clarification instead of claiming an ambiguous correction was applied", async () => {
  const db = new MemoryStore();
  const workflow = new VisitWorkflow(db);
  const started = await workflow.ingestText({ providerKey: "ambiguous-start", actorId: "user_anika", text: "Start a visit to Lyon." });
  await workflow.ingestText({ providerKey: "ambiguous-note", actorId: "user_anika", text: "The entrance is tidy." });
  const user = await db.getUser("user_anika");
  await workflow.prepareCurrentDraft(user, started.visit!.id);
  const result = await workflow.handleIncomingText({ providerKey: "ambiguous-remove", actorId: "user_anika", text: "Please remove it." });
  assert.match(result.reply ?? "", /Remove: The entrance is tidy/i);
  assert.equal(result.visit?.draft?.version, 1);
});

test("removes an explicitly quoted observation in a revised draft", async () => {
  const db = new MemoryStore();
  const workflow = new VisitWorkflow(db);
  const user = await db.getUser("user_anika");
  const started = await workflow.ingestText({ providerKey: "remove-start", actorId: user.id, text: "Start a visit to Lyon." });
  await workflow.ingestText({ providerKey: "remove-note", actorId: user.id, text: "The entrance is tidy." });
  await workflow.prepareCurrentDraft(user, started.visit!.id);
  const result = await workflow.handleIncomingText({ providerKey: "remove-command", actorId: user.id, text: "Remove: The entrance is tidy." });
  assert.equal(result.visit?.draft?.findings.length, 0);
  assert.match(result.reply ?? "", /Correction applied/i);
});

test("asks which matching observation to remove, then accepts a specific natural removal", async () => {
  const db = new MemoryStore();
  const workflow = new VisitWorkflow(db);
  const user = await db.getUser("user_anika");
  const started = await workflow.ingestText({ providerKey: "natural-remove-start", actorId: user.id, text: "Start a visit to Lyon." });
  await workflow.ingestText({ providerKey: "natural-remove-note", actorId: user.id, text: "The entrance sign is damaged. The stockroom sign is missing." });
  await workflow.prepareCurrentDraft(user, started.visit!.id);
  const ambiguous = await workflow.handleIncomingText({ providerKey: "natural-remove-ambiguous", actorId: user.id, text: "Remove the sign issue." });
  assert.match(ambiguous.reply ?? "", /which observation/i);
  assert.equal(ambiguous.visit?.draft?.version, 1);
  const specific = await workflow.handleIncomingText({ providerKey: "natural-remove-specific", actorId: user.id, text: "Remove the entrance-sign observation only." });
  assert.deepEqual(specific.visit?.draft?.findings.map((finding) => finding.text), ["The stockroom sign is missing."]);
  assert.equal(specific.visit?.draft?.version, 2);
});

test("accepts the documented colon correction format", async () => {
  const db = new MemoryStore();
  const workflow = new VisitWorkflow(db);
  const user = await db.getUser("user_anika");
  const started = await workflow.ingestText({ providerKey: "colon-change-start", actorId: user.id, text: "Start a visit to Lyon." });
  await workflow.ingestText({ providerKey: "colon-change-note", actorId: user.id, text: "The entrance is tidy." });
  const recorded = await workflow.handleIncomingText({ providerKey: "colon-change-command", actorId: user.id, text: "Change: The entrance is tidy to The entrance sign is damaged." });
  assert.match(recorded.reply ?? "", /Correction recorded/i);
  const drafted = await workflow.prepareCurrentDraft(user, started.visit!.id);
  assert.deepEqual(drafted.draft?.findings.map((finding) => finding.text), ["The entrance sign is damaged."]);
  assert.equal(drafted.draft?.version, 1);
});
