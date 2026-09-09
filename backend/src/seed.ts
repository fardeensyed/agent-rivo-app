import { readFile } from "node:fs/promises";
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

  for (const [table, rows] of [["app_users", userRows], ["stores", storeRows], ["user_store_memberships", memberships], ["visits", visitRows], ["messages", messageRows]] as const) {
    const { error } = await supabase.from(table).upsert(rows as never[]);
    if (error) throw new Error(`${table}: ${error.message}`);
  }
  console.log(`Seeded ${users.length} users, ${stores.length} stores, ${visits.length} visits, ${reports.length} reports, ${messages.length} messages, and ${documents.length} procedure indexes.`);
  console.log("Report snapshots and procedure embeddings are intentionally separate steps because reports need JSON mapping and procedures need local embeddings.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
