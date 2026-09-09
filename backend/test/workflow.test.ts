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
