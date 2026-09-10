// Independent acceptance checks. Failures document release gaps; no live services are called.
import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../src/store.js";
import { SupabaseStore } from "../src/supabase-store.js";
import { VisitWorkflow } from "../src/workflow.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Visit } from "../src/domain.js";

// The shipped MemoryStore saveVisit is a no-op, which loses the new object
// returned by validateDraft. Model an actual write for lifecycle audit checks.
class PersistedMemoryStore extends MemoryStore {
  override async saveVisit(visit: Visit): Promise<void> {
    const index = this.visits.findIndex(item => item.id === visit.id);
    assert.notEqual(index, -1);
    this.visits[index] = structuredClone(visit);
  }
}

function fixture() {
  const db = new PersistedMemoryStore();
  const workflow = new VisitWorkflow(db, async () => "Procedure answer");
  let sequence = 0;
  const send = (text: string) => workflow.handleIncomingText({ actorId: "user_anika", providerKey: `audit:${++sequence}`, text });
  return { db, workflow, send };
}

test("A09: public webhook rejects synthetic identity selection with local runner disabled", { timeout: 15000 }, async () => {
  const script = `
    import http from 'node:http';
    Object.assign(process.env, {
      PORT: '0', SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_SECRET_KEY: '',
      SUPABASE_PUBLISHABLE_KEY: '', GROQ_API_KEY: '', UNIPILE_API_KEY: '', UNIPILE_DSN: '',
      UNIPILE_ACCOUNT_ID: 'audit-account', UNIPILE_SENDER_ID: 'audit-sender',
      UNIPILE_ACTOR_ID: 'user_anika', UNIPILE_WEBHOOK_SECRET: 'audit-only-fake-secret',
      ENABLE_LOCAL_TEST_RUNNER: 'false'
    });
    const original = http.Server.prototype.listen;
    http.Server.prototype.listen = function() {
      this.once('listening', () => console.log('AUDIT_PORT=' + this.address().port));
      return original.call(this, 0, '127.0.0.1');
    };
    await import('./backend/src/server.ts');
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)), stdio: ["ignore", "pipe", "pipe"], windowsHide: true
  });
  try {
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Isolated audit server did not start")), 10000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", () => { clearTimeout(timer); reject(new Error("Isolated server exited")); });
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk.toString();
        const match = /AUDIT_PORT=(\d+)/.exec(output);
        if (match) { clearTimeout(timer); resolve(Number(match[1])); }
      });
    });
    const response = await fetch(`http://127.0.0.1:${port}/api/webhooks/whatsapp`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerKey: "audit:forgery", actorId: "user_noah", text: "Start a visit to Lille." })
    });
    assert.ok([401, 403, 404].includes(response.status), `Unauthenticated identity-selecting POST returned ${response.status}`);
  } finally { child.kill(); }
});

test("A05: a refusal to validate does not approve the report", async () => {
  const { send } = fixture();
  await send("Start a visit to Lyon."); await send("The entrance is tidy."); await send("Prepare the report.");
  const result = await send("Do not validate this report.");
  assert.notEqual(result.visit?.state, "validated");
});

test("A05: validated reports cannot be reopened by the draft API workflow", async () => {
  const { send, db, workflow } = fixture();
  await send("Start a visit to Lyon."); await send("The entrance is tidy."); await send("Prepare the report.");
  const result = await send("I validate the latest draft.");
  assert.equal((await db.getVisit(result.visit!.id))?.state, "validated");
  await assert.rejects(() => workflow.prepareCurrentDraft(db.users[0], result.visit!.id));
});

test("A05: shipped MemoryStore actually persists validation", async () => {
  const db = new MemoryStore(); const workflow = new VisitWorkflow(db);
  const start = await workflow.ingestText({ providerKey: "audit:memory-start", actorId: "user_anika", text: "Start a visit to Lyon." });
  await workflow.prepareCurrentDraft(db.users[0], start.visit!.id);
  await workflow.validate(db.users[0], start.visit!.id, 1);
  assert.equal((await db.getVisit(start.visit!.id))?.state, "validated");
});

test("P06: handbook wording starts a visit and removes only the specified clause", async () => {
  const { send } = fixture();
  const start = await send("Start Lyon. The entrance sign is damaged and the stockroom sign is missing.");
  assert.equal(start.visit?.storeId, "store_lyon");
  await send("Remove the sign issue.");
  await send("Remove the entrance-sign observation only.");
  const result = await send("Prepare the report.");
  const text = result.visit?.draft?.findings.map(f => f.text).join(" ") ?? "";
  assert.match(text, /stockroom sign is missing/i); assert.doesNotMatch(text, /entrance sign is damaged/i);
});

test("A04: an unmatched correction must not claim it was applied", async () => {
  const { send } = fixture();
  await send("Start a visit to Lyon."); await send("The entrance is tidy."); await send("Prepare the report.");
  const result = await send("Change fifteen boxes to five.");
  assert.doesNotMatch(result.reply ?? "", /Correction applied/i);
});

test("P06: removing one clause does not remove the other observation", async () => {
  const { send } = fixture();
  await send("Start a visit to Lyon.");
  await send("The entrance sign is damaged and the stockroom sign is missing.");
  await send("Remove the entrance-sign observation only.");
  const result = await send("Prepare the report.");
  const text = result.visit?.draft?.findings.map(f => f.text).join(" ") ?? "";
  assert.match(text, /stockroom sign is missing/i);
  assert.doesNotMatch(text, /entrance sign is damaged/i);
});

test("A04: two matching quantities require clarification", async () => {
  const { send } = fixture();
  await send("Start a visit to Lyon.");
  await send("Fifteen boxes are outside storage. Fifteen boxes are beside the entrance.");
  await send("Prepare the report.");
  const result = await send("Change fifteen boxes to five.");
  assert.match(result.reply ?? "", /which|clarif|specify/i);
});

test("A02/A05: a new audio draft is shown before latest-version approval", async () => {
  const { send, db, workflow } = fixture();
  await send("Start a visit to Lyon."); await send("The entrance is tidy."); await send("Prepare the report.");
  const pending = await workflow.ingestUnipileEvent({ event: "message_received", account_id: "audit", account_type: "WHATSAPP", message_id: "audio", attachments: [{ id: "attachment" }] }, "user_anika");
  assert.ok("message" in pending);
  const result = await workflow.completeAudioMessage(pending.message, "The tablet is broken.", "audit-placeholder");
  assert.match(result.reply ?? "", /The entrance is tidy/);
  assert.equal(db.messages.at(-1)?.processingStatus, "completed");
});

test("A09: another manager's unpublished draft stays private in a shared store", async () => {
  const { send, db } = fixture();
  await send("Start a visit to Lyon.");
  const noah = { ...db.users[1], storeIds: ["store_lyon"] };
  assert.equal((await db.getVisibleVisits(noah)).length, 0);
});

test("A11: simultaneous duplicate delivery has one effect", async () => {
  const { send, db, workflow } = fixture();
  await send("Start a visit to Lyon.");
  const event = { providerKey: "audit:concurrent", actorId: "user_anika", text: "The entrance is tidy." };
  await Promise.all([workflow.ingestText(event), workflow.ingestText(event)]);
  assert.equal(db.messages.filter(m => m.providerKey === event.providerKey).length, 1);
});

test("A12: retrying a procedure provider failure retries the work", async () => {
  const db = new MemoryStore(); let calls = 0;
  const workflow = new VisitWorkflow(db, async () => { if (++calls === 1) throw new Error("simulated timeout"); return "Record the symptom."; });
  const event = { providerKey: "audit:retry", actorId: "user_anika", text: "What should I record for an equipment incident?" };
  await assert.rejects(() => workflow.handleIncomingText(event), /simulated timeout/);
  const result = await workflow.handleIncomingText(event);
  assert.equal(result.reply, "Record the symptom.");
});

test("A07: Supabase persists audio procedure/correction classification", async () => {
  let update: Record<string, unknown> = {};
  const client = { from: () => ({ update: (value: Record<string, unknown>) => { update = value; return { eq: async () => ({ error: null }) }; } }) } as unknown as SupabaseClient;
  const db = new SupabaseStore(client);
  await db.updateMessage({ id: "audit-message", providerKey: "audit:audio", actorId: "user_anika", kind: "procedural_question", transcript: "What should I record?", processingStatus: "completed", receivedAt: "2026-09-07T08:00:00Z" });
  assert.equal(update.kind, "procedural_question");
});

test("P02: relative follow-up date resolves using the visit context", async () => {
  const { workflow, db } = fixture();
  const start = await workflow.ingestText({ providerKey: "audit:date-start", actorId: "user_anika", text: "Start a visit to Lyon.", receivedAt: "2026-09-07T10:00:00+02:00" });
  await workflow.ingestText({ providerKey: "audit:date-note", actorId: "user_anika", text: "Sarah should check the tablet with IT by Friday.", receivedAt: "2026-09-07T10:01:00+02:00" });
  const result = await workflow.prepareCurrentDraft(db.users[0], start.visit!.id);
  assert.match(result.draft?.followUpNotes[0]?.text ?? "", /11 September 2026|2026-09-11/);
});
