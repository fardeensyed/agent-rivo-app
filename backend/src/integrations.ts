import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import Groq from "groq-sdk";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "./config.js";

const require = createRequire(import.meta.url);
const ffmpegPath = require("ffmpeg-static") as string | null;

export function createSupabaseAdmin(): SupabaseClient | undefined {
  if (!config.hasSupabase) return undefined;
  return createClient(config.supabaseUrl!, config.supabaseSecretKey!, { auth: { persistSession: false, autoRefreshToken: false } });
}

export function createGroqClient(): Groq | undefined {
  return config.hasGroq ? new Groq({ apiKey: config.groqApiKey }) : undefined;
}

export function requireReliableTranscript(value: string): string {
  const transcript = value.trim();
  const normalized = transcript
    .toLocaleLowerCase()
    .replace(/’/g, "'")
    .replace(/[^\p{L}\p{N}']+/gu, " ")
    .trim();
  // Whisper can emit a short hallucination for silence. These tokens are not
  // useful factual observations and must never enter a visit report.
  const genericSilenceOutput = /^(you|the|uh|um|so|and|but|okay|ok|yeah|yes|no|hmm|mm|thank you|thanks|thank you very much|you are welcome|thanks for listening|thanks for watching|thank you for watching|bye|goodbye|the end|please subscribe)$/;
  const vagueTransitionOutput = /^(?:i am|i'm|we are|we're) going to (?:go to )?(?:the )?next (?:one|item)$/;
  if (!normalized || genericSilenceOutput.test(normalized) || vagueTransitionOutput.test(normalized)) {
    throw new Error("VOICE_TRANSCRIPT_UNRELIABLE");
  }
  return transcript;
}

const SILENT_AUDIO_MAX_DB = -55;
const SILENT_AUDIO_MAX_MEAN_DB = -50;

export function requireShortAudio(ffmpegOutput: string): void {
  const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(ffmpegOutput);
  if (!match) throw new Error("VOICE_AUDIO_DURATION_UNAVAILABLE");
  if (Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) > 120) throw new Error("VOICE_NOTE_TOO_LONG");
}

export function audioAppearsSilent(ffmpegOutput: string): boolean {
  const readVolume = (label: "max" | "mean") => ffmpegOutput.match(new RegExp(label + "_volume:\\s*(-?(?:\\d+(?:\\.\\d+)?|inf)) dB", "i"))?.[1];
  const maximum = readVolume("max");
  if (!maximum) throw new Error("VOICE_AUDIO_ANALYSIS_FAILED");
  if (maximum.toLowerCase() === "-inf") return true;
  const maxVolume = Number(maximum);
  if (!Number.isFinite(maxVolume)) throw new Error("VOICE_AUDIO_ANALYSIS_FAILED");
  const mean = readVolume("mean");
  if (!mean) return maxVolume <= SILENT_AUDIO_MAX_DB;
  if (mean.toLowerCase() === "-inf") return true;
  const meanVolume = Number(mean);
  if (!Number.isFinite(meanVolume)) throw new Error("VOICE_AUDIO_ANALYSIS_FAILED");
  // A short click can have a high peak while the complete clip remains silent.
  return maxVolume <= SILENT_AUDIO_MAX_DB || meanVolume <= SILENT_AUDIO_MAX_MEAN_DB;
}

export async function requireAudibleAudio(audio: Buffer): Promise<void> {
  if (!ffmpegPath) throw new Error("VOICE_AUDIO_ANALYSIS_UNAVAILABLE");
  // MP4/M4A metadata needs random access, so analyse a temporary local copy
  // rather than streaming bytes through stdin. The directory is deleted in all cases.
  const directory = await mkdtemp(path.join(tmpdir(), "agent-rivo-audio-"));
  const audioFile = path.join(directory, "input-audio");
  try {
    await writeFile(audioFile, audio);
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(ffmpegPath, ["-hide_banner", "-i", audioFile, "-vn", "-af", "volumedetect", "-f", "null", "-"], {
        stdio: ["ignore", "ignore", "pipe"], windowsHide: true
      });
      const timer = setTimeout(() => { child.kill(); reject(new Error("VOICE_AUDIO_ANALYSIS_TIMEOUT")); }, 30000);
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => { stderr += chunk; });
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", (code: number | null) => { clearTimeout(timer); code === 0 ? resolve(stderr) : reject(new Error(`VOICE_AUDIO_ANALYSIS_FAILED:${code}`)); });
    });
    requireShortAudio(output);
    if (audioAppearsSilent(output)) throw new Error("VOICE_NOTE_SILENT");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function transcribeAudio(audio: Buffer, filename = "voice-note.wav") {
  const groq = createGroqClient();
  if (!groq) throw new Error("GROQ_NOT_CONFIGURED");
  const bytes = audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength) as ArrayBuffer;
  const result = await groq.audio.transcriptions.create({
    file: new File([bytes], filename),
    model: config.groqSttModel,
    response_format: "json",
    temperature: 0
  }, { timeout: 90000, maxRetries: 0 });
  return requireReliableTranscript(result.text);
}

const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const VOICE_BUCKET = "voice-notes";

export async function downloadUnipileAttachment(messageId: string, attachmentId: string): Promise<{ bytes: Buffer; contentType: string }> {
  if (!config.unipileDsn || !config.unipileApiKey) throw new Error("UNIPILE_NOT_CONFIGURED");
  const response = await fetch(`https://${config.unipileDsn}/api/v1/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`, {
    signal: AbortSignal.timeout(30000),
    headers: { "X-API-KEY": config.unipileApiKey, accept: "application/octet-stream" }
  });
  if (!response.ok) throw new Error(`UNIPILE_ATTACHMENT_DOWNLOAD_FAILED:${response.status}`);
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_AUDIO_BYTES) throw new Error("VOICE_NOTE_TOO_LARGE");
  if (!response.body) throw new Error("VOICE_NOTE_EMPTY");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > MAX_AUDIO_BYTES) { await reader.cancel(); throw new Error("VOICE_NOTE_TOO_LARGE"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = Buffer.concat(chunks);
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
