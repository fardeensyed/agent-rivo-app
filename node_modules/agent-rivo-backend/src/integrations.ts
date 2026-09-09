import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import Groq from "groq-sdk";
import { config } from "./config.js";

export function createSupabaseAdmin(): SupabaseClient | undefined {
  if (!config.hasSupabase) return undefined;
  return createClient(config.supabaseUrl!, config.supabaseSecretKey!, { auth: { persistSession: false, autoRefreshToken: false } });
}

export function createGroqClient(): Groq | undefined {
  return config.hasGroq ? new Groq({ apiKey: config.groqApiKey }) : undefined;
}

export async function transcribeAudio(audio: Buffer, filename = "voice-note.wav") {
  const groq = createGroqClient();
  if (!groq) throw new Error("GROQ_NOT_CONFIGURED");
  const bytes = audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength) as ArrayBuffer;
  const result = await groq.audio.transcriptions.create({ file: new File([bytes], filename), model: config.groqSttModel, response_format: "json" });
  return result.text;
}
