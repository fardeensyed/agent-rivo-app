import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { z } from "zod";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(moduleDirectory, "../../.env") });

export const config = z.object({
  port: z.coerce.number().default(3001),
  supabaseUrl: z.string().url().optional(),
  supabasePublishableKey: z.string().optional(),
  supabaseSecretKey: z.string().optional(),
  groqApiKey: z.string().optional(),
  // Keep this aligned with the currently available Groq free-plan chat model.
  groqChatModel: z.string().default("openai/gpt-oss-20b"),
  groqSttModel: z.string().default("whisper-large-v3-turbo"),
  embeddingModel: z.string().default("Supabase/gte-small"),
  unipileDsn: z.string().optional(),
  unipileApiKey: z.string().optional(),
  unipileAccountId: z.string().optional(),
  unipileSenderId: z.string().optional(),
  unipileActorId: z.string().default("user_anika"),
  unipileWebhookSecret: z.string().optional(),
  enableLocalTestRunner: z.enum(["true", "false"]).default("false").transform((value) => value === "true")
}).transform((env) => ({
  ...env,
  hasSupabase: Boolean(env.supabaseUrl && env.supabaseSecretKey),
  hasGroq: Boolean(env.groqApiKey)
})).parse({
  port: process.env.PORT,
  supabaseUrl: process.env.SUPABASE_URL,
  supabasePublishableKey: process.env.SUPABASE_PUBLISHABLE_KEY,
  supabaseSecretKey: process.env.SUPABASE_SECRET_KEY,
  groqApiKey: process.env.GROQ_API_KEY,
  groqChatModel: process.env.GROQ_CHAT_MODEL,
  groqSttModel: process.env.GROQ_STT_MODEL,
  embeddingModel: process.env.EMBEDDING_MODEL,
  unipileDsn: process.env.UNIPILE_DSN,
  unipileApiKey: process.env.UNIPILE_API_KEY,
  unipileAccountId: process.env.UNIPILE_ACCOUNT_ID,
  unipileSenderId: process.env.UNIPILE_SENDER_ID,
  unipileActorId: process.env.UNIPILE_ACTOR_ID,
  unipileWebhookSecret: process.env.UNIPILE_WEBHOOK_SECRET,
  enableLocalTestRunner: process.env.ENABLE_LOCAL_TEST_RUNNER
});
