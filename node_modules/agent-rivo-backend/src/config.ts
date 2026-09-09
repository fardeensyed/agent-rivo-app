import "dotenv/config";
import { z } from "zod";

export const config = z.object({
  port: z.coerce.number().default(3001),
  supabaseUrl: z.string().url().optional(),
  supabasePublishableKey: z.string().optional(),
  supabaseSecretKey: z.string().optional(),
  groqApiKey: z.string().optional(),
  groqChatModel: z.string().default("llama-3.3-70b-versatile"),
  groqSttModel: z.string().default("whisper-large-v3-turbo"),
  unipileAccountId: z.string().optional(),
  unipileSenderId: z.string().optional(),
  unipileActorId: z.string().default("user_anika"),
  unipileWebhookSecret: z.string().optional()
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
  unipileAccountId: process.env.UNIPILE_ACCOUNT_ID,
  unipileSenderId: process.env.UNIPILE_SENDER_ID,
  unipileActorId: process.env.UNIPILE_ACTOR_ID,
  unipileWebhookSecret: process.env.UNIPILE_WEBHOOK_SECRET
});
