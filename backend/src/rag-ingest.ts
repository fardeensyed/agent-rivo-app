import { createSupabaseAdmin } from "./integrations.js";
import { ingestProcedureCorpus } from "./procedures.js";

async function main() {
  const kitRoot = process.env.ASSESSMENT_KIT_DIR;
  if (!kitRoot) throw new Error("Set ASSESSMENT_KIT_DIR to the supplied agent-rivo-candidate-kit-v2 folder.");
  const supabase = createSupabaseAdmin();
  if (!supabase) throw new Error("Set SUPABASE_URL and SUPABASE_SECRET_KEY before procedure ingestion.");
  const count = await ingestProcedureCorpus(supabase, kitRoot);
  console.log(`Indexed ${count} approved procedure passages with Supabase/gte-small embeddings.`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
