import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../src/store.js";
import { VisitWorkflow } from "../src/workflow.js";

test("replaying a provider event has one effect", async () => {
  const db = new MemoryStore();
  const workflow = new VisitWorkflow(db);
  const event = { providerKey: "provider-1", actorId: "user_anika", text: "Start a visit to Lyon.", receivedAt: "2026-09-07T10:01:00+02:00" };
  assert.equal((await workflow.ingestText(event)).duplicate, false);
  assert.equal((await workflow.ingestText(event)).duplicate, true);
  assert.equal(db.visits.length, 1);
  assert.equal(db.messages.length, 1);
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

test("does not attach another store's notes to an active visit", async () => {
  const workflow = new VisitWorkflow(new MemoryStore());
  await workflow.ingestText({ providerKey: "switch-start", actorId: "user_anika", text: "Start a visit to Lyon." });
  await assert.rejects(() => workflow.ingestText({ providerKey: "switch-other-store", actorId: "user_anika", text: "Now I am at Nantes. The entrance is tidy." }), /ACTIVE_VISIT_REQUIRES_FINISH_OR_CANCEL/);
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
  assert.match(result.reply ?? "", /which observation/i);
  assert.equal(result.visit?.draft?.version, 1);
});
