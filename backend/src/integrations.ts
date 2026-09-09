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

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const VOICE_BUCKET = "voice-notes";

export async function downloadUnipileAttachment(messageId: string, attachmentId: string): Promise<{ bytes: Buffer; contentType: string }> {
  if (!config.unipileDsn || !config.unipileApiKey) throw new Error("UNIPILE_NOT_CONFIGURED");
  const response = await fetch(`https://${config.unipileDsn}/api/v1/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`, {
    headers: { "X-API-KEY": config.unipileApiKey, accept: "application/octet-stream" }
  });
  if (!response.ok) throw new Error(`UNIPILE_ATTACHMENT_DOWNLOAD_FAILED:${response.status}`);
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_AUDIO_BYTES) throw new Error("VOICE_NOTE_TOO_LARGE");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length) throw new Error("VOICE_NOTE_EMPTY");
  if (bytes.length > MAX_AUDIO_BYTES) throw new Error("VOICE_NOTE_TOO_LARGE");
  return { bytes, contentType: response.headers.get("content-type")?.split(";")[0] || "audio/ogg" };
}

export async function storePrivateVoiceNote(path: string, bytes: Buffer, contentType: string): Promise<string> {
  const supabase = createSupabaseAdmin();
  if (!supabase) throw new Error("SUPABASE_NOT_CONFIGURED");
  const { data: existingBucket } = await supabase.storage.getBucket(VOICE_BUCKET);
  if (!existingBucket) {
    const { error: bucketError } = await supabase.storage.createBucket(VOICE_BUCKET, {
      public: false,
      fileSizeLimit: MAX_AUDIO_BYTES,
      allowedMimeTypes: ["audio/*", "video/mp4", "application/octet-stream"]
    });
    if (bucketError && !/already exists/i.test(bucketError.message)) throw new Error(`VOICE_BUCKET_CREATE_FAILED:${bucketError.message}`);
  }
  const { error } = await supabase.storage.from(VOICE_BUCKET).upload(path, bytes, { contentType, upsert: false });
  if (error) throw new Error(`VOICE_UPLOAD_FAILED:${error.message}`);
  return path;
}

export async function createPrivateVoiceNoteUrl(path: string, expiresInSeconds = 300): Promise<string> {
  const supabase = createSupabaseAdmin();
  if (!supabase) throw new Error("SUPABASE_NOT_CONFIGURED");
  const { data, error } = await supabase.storage.from(VOICE_BUCKET).createSignedUrl(path, expiresInSeconds);
  if (error || !data) throw new Error(`VOICE_URL_FAILED:${error?.message ?? "UNKNOWN"}`);
  return data.signedUrl;
}

export async function sendUnipileText(chatId: string, text: string): Promise<void> {
  if (!config.unipileDsn || !config.unipileApiKey) return;
  const form = new FormData();
  form.set("text", text);
  const response = await fetch(`https://${config.unipileDsn}/api/v1/chats/${encodeURIComponent(chatId)}/messages`, {
    method: "POST",
    headers: { "X-API-KEY": config.unipileApiKey, accept: "application/json" },
    body: form
  });
  if (!response.ok) throw new Error(`UNIPILE_REPLY_FAILED:${response.status}`);
}
