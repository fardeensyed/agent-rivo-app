import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../src/store.js";
import { VisitWorkflow } from "../src/workflow.js";

test("replaying a provider event has one effect", () => {
  const db = new MemoryStore();
  const workflow = new VisitWorkflow(db);
  const event = { providerKey: "provider-1", actorId: "user_anika", text: "Start a visit to Lyon.", receivedAt: "2026-09-07T10:01:00+02:00" };
  assert.equal(workflow.ingestText(event).duplicate, false);
  assert.equal(workflow.ingestText(event).duplicate, true);
  assert.equal(db.visits.length, 1);
  assert.equal(db.messages.length, 1);
});

test("validation requires the current draft version", () => {
  const db = new MemoryStore();
  const workflow = new VisitWorkflow(db);
  const { visit } = workflow.ingestText({ providerKey: "provider-2", actorId: "user_anika", text: "Start a visit to Lyon." });
  assert.ok(visit);
  workflow.prepareDraft(db.user("user_anika"), visit!.id, { version: 2, title: "Lyon report", summary: "Observed facts only.", findings: [], followUpNotes: [], sourceMessageIds: [] });
  assert.throws(() => workflow.validate(db.user("user_anika"), visit!.id, 1), /STALE_DRAFT/);
  assert.equal(workflow.validate(db.user("user_anika"), visit!.id, 2).state, "validated");
});

test("a user cannot start an unauthorised store visit", () => {
  const workflow = new VisitWorkflow(new MemoryStore());
  assert.throws(() => workflow.ingestText({ providerKey: "provider-3", actorId: "user_noah", text: "Start a visit to Lyon." }), /FORBIDDEN_STORE/);
});

test("adapts the real Unipile message_received shape", () => {
  const db = new MemoryStore();
  const workflow = new VisitWorkflow(db);
  const result = workflow.ingestUnipileEvent({
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
