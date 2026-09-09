import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { createSupabaseAdmin } from "./integrations.js";

type Fixture = Record<string, unknown>;

async function jsonFile<T extends Fixture | Fixture[]>(root: string, name: string): Promise<T> {
  return JSON.parse(await readFile(path.join(root, "data", name), "utf8")) as T;
}

function requireAdmin() {
  const client = createSupabaseAdmin();
  if (!client) throw new Error("Set SUPABASE_URL and SUPABASE_SECRET_KEY before seeding.");
  return client;
}

function stableUuid(value: string): string {
  const digest = createHash("sha256").update(value).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

async function main() {
  const kitRoot = process.env.ASSESSMENT_KIT_DIR;
  if (!kitRoot) throw new Error("Set ASSESSMENT_KIT_DIR to the supplied agent-rivo-candidate-kit-v2 folder.");
  const supabase = requireAdmin();
  const users = await jsonFile<Fixture[]>(kitRoot, "users.json");
  const stores = await jsonFile<Fixture[]>(kitRoot, "stores.json");
  const visits = await jsonFile<Fixture[]>(kitRoot, "visits.json");
  const reports = await jsonFile<Fixture[]>(kitRoot, "reports.json");
  const messages = await jsonFile<Fixture[]>(kitRoot, "messages.json");
  const documents = await jsonFile<Fixture[]>(kitRoot, "documents.json");

  const userRows = users.map((user) => ({ id: user.id, display_name: user.display_name, role: user.role }));
  const storeRows = stores.map((store) => ({ id: store.id, name: store.name, city: store.city, timezone: store.timezone, local_contact_name: store.local_contact_name }));
  const memberships = users.flatMap((user) => (user.store_ids as string[]).map((storeId) => ({ user_id: user.id, store_id: storeId })));
  const visitRows = visits.map((visit) => ({ id: visit.id, store_id: visit.store_id, author_id: visit.author_id, state: visit.state, started_at: visit.started_at, validated_at: visit.validated_at, validated_by: visit.author_id, latest_draft_version: visit.latest_draft_version }));
  const messageRows = messages.map((message) => ({ id: message.id, provider_account_id: "fixture", provider_message_id: message.id, visit_id: message.visit_id, actor_id: message.actor_id, kind: message.kind, text_content: message.text, received_at: message.received_at, processing_status: "completed" }));

  const seededReports = reports.map((report) => {
    const findings = ((report.findings as Fixture[] | undefined) ?? []).map((finding) => ({
      id: String(finding.id), category: finding.category, kind: finding.kind, text: finding.text,
      sourceMessageIds: (finding.source_message_ids as string[] | undefined) ?? []
    }));
    const followUpNotes = ((report.followup_notes as Fixture[] | undefined) ?? []).map((note) => ({
      text: String(note.text), sourceMessageIds: (note.source_message_ids as string[] | undefined) ?? []
    }));
    const sourceMessageIds = Array.from(new Set([
      ...findings.flatMap((finding) => finding.sourceMessageIds),
      ...followUpNotes.flatMap((note) => note.sourceMessageIds),
      ...(report.validation_message_id ? [String(report.validation_message_id)] : [])
    ]));
    const draft = {
      version: Number(report.version), title: String(report.title), summary: String(report.summary),
      findings, followUpNotes, sourceMessageIds
    };
    const draftId = stableUuid(`draft:${report.id}`);
    return {
      draft: { id: draftId, visit_id: report.visit_id, version: draft.version, title: draft.title, summary: draft.summary, report_json: draft, source_message_ids: sourceMessageIds },
      validated: { id: stableUuid(`report:${report.id}`), visit_id: report.visit_id, draft_id: draftId, version: draft.version, report_json: draft, validated_by: report.validated_by, validated_at: report.validated_at, validation_message_id: report.validation_message_id }
    };
  });

  for (const [table, rows] of [["app_users", userRows], ["stores", storeRows], ["user_store_memberships", memberships], ["visits", visitRows], ["messages", messageRows]] as const) {
    const { error } = await supabase.from(table).upsert(rows as never[]);
    if (error) throw new Error(`${table}: ${error.message}`);
  }
  const { error: draftsError } = await supabase.from("report_drafts").upsert(seededReports.map((item) => item.draft) as never[], { onConflict: "visit_id,version" });
  if (draftsError) throw new Error(`report_drafts: ${draftsError.message}`);
  const { error: reportsError } = await supabase.from("validated_reports").upsert(seededReports.map((item) => item.validated) as never[], { onConflict: "visit_id" });
  if (reportsError) throw new Error(`validated_reports: ${reportsError.message}`);
  console.log(`Seeded ${users.length} users, ${stores.length} stores, ${visits.length} visits, ${reports.length} validated reports, and ${messages.length} messages.`);
  console.log(`${documents.length} procedure documents are ready for the next RAG-indexing step.`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
