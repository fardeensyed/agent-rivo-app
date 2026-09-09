import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { createGroqClient } from "./integrations.js";

export interface ProcedureChunk {
  documentId: string;
  title: string;
  section: string;
  version: string;
  content: string;
}

export interface RetrievedProcedureChunk extends ProcedureChunk {
  similarity: number;
}

type ProcedureDocument = { id: string; title: string; version: string; path: string };

let extractor: Promise<FeatureExtractionPipeline> | undefined;

export function isProcedureQuestion(text: string): boolean {
  const value = text.trim().toLowerCase();
  return /\?$/.test(value)
    || /\b(what should i (record|collect|do)|which procedure|procedure (appl(?:y|ies)|say)|replacement price|guaranteed response|warranty|how should i report|what information)\b/.test(value);
}

async function getExtractor() {
  extractor ??= pipeline("feature-extraction", config.embeddingModel) as Promise<FeatureExtractionPipeline>;
  return extractor;
}

export async function embedText(text: string): Promise<number[]> {
  const model = await getExtractor();
  const output = await model(text, { pooling: "mean", normalize: true });
  const values = Array.from((output as { data: Float32Array }).data);
  if (values.length !== 384) throw new Error(`UNEXPECTED_EMBEDDING_DIMENSION:${values.length}`);
  return values;
}

function splitSections(markdown: string, document: ProcedureDocument): ProcedureChunk[] {
  const body = markdown.replace(/^---[\s\S]*?---\s*/m, "").trim();
  const parts = body.split(/^##\s+/m);
  const heading = parts.shift()?.replace(/^#\s+/, "").trim() || document.title;
  return parts.map((part) => {
    const [sectionLine, ...contentLines] = part.split("\n");
    const section = sectionLine.trim();
    const content = contentLines.join("\n").trim();
    return { documentId: document.id, title: document.title || heading, section, version: document.version, content };
  }).filter((chunk) => chunk.content.length > 0);
}

export async function loadProcedureChunks(kitRoot: string): Promise<ProcedureChunk[]> {
  const documents = JSON.parse(await readFile(path.join(kitRoot, "data", "documents.json"), "utf8")) as ProcedureDocument[];
  const chunks = await Promise.all(documents.map(async (document) => {
    const markdown = await readFile(path.join(kitRoot, document.path), "utf8");
    return splitSections(markdown, document);
  }));
  return chunks.flat();
}

export async function ingestProcedureCorpus(client: SupabaseClient, kitRoot: string): Promise<number> {
  const chunks = await loadProcedureChunks(kitRoot);
  const rows = await Promise.all(chunks.map(async (chunk) => ({
    document_id: chunk.documentId,
    title: chunk.title,
    section: chunk.section,
    version: chunk.version,
    content: chunk.content,
    embedding: await embedText(`${chunk.title}\n${chunk.section}\n${chunk.content}`),
    metadata: { source: "assessment-kit", path: `procedures/${chunk.documentId}` }
  })));
  const { error } = await client.from("procedure_chunks").upsert(rows, { onConflict: "document_id,section" });
  if (error) throw new Error(`PROCEDURE_INGEST_FAILED:${error.message}`);
  return rows.length;
}

export async function retrieveProcedureChunks(client: SupabaseClient, question: string): Promise<RetrievedProcedureChunk[]> {
  const queryEmbedding = await embedText(question);
  const { data, error } = await client.rpc("match_procedure_chunks", { query_embedding: queryEmbedding, match_count: 3 });
  if (error) throw new Error(`PROCEDURE_RETRIEVAL_FAILED:${error.message}`);
  return (data ?? []).map((row: Record<string, unknown>) => ({
    documentId: String(row.document_id), title: String(row.title), section: String(row.section), version: String(row.version), content: String(row.content), similarity: Number(row.similarity)
  }));
}

export class ProcedureAssistant {
  constructor(private readonly client: SupabaseClient) {}

  async answer(question: string): Promise<string> {
    const chunks = await retrieveProcedureChunks(this.client, question);
    if (!chunks.length) return "I could not find an approved procedure that answers that. Please check the applicable internal agreement or ask headquarters.";
    // Keep the answer grounded in the best-matching SOP. A nearby passage from
    // another procedure can be topically similar but still be wrong guidance.
    const bestDocumentId = chunks[0].documentId;
    const groundedChunks = chunks.filter((chunk) => chunk.documentId === bestDocumentId);
    const sources = groundedChunks.map((chunk) => `[${chunk.documentId} · ${chunk.title} · ${chunk.section} · v${chunk.version}]\n${chunk.content}`).join("\n\n");
    const groq = createGroqClient();
    let answer: string;
    if (!groq) {
      answer = `The approved procedure says: ${chunks[0].content}`;
    } else {
      const completion = await groq.chat.completions.create({
        model: config.groqChatModel,
        temperature: 0,
        max_completion_tokens: 400,
        messages: [
          { role: "system", content: "Answer only from the supplied approved procedure excerpts. Be concise. If the excerpts do not specify a requested price, guarantee, deadline, or fact, explicitly say it is not specified. Do not turn procedure advice into a visit observation, task, promise, or diagnosis." },
          { role: "user", content: `Question: ${question}\n\nApproved procedure excerpts:\n${sources}` }
        ]
      });
      answer = completion.choices[0]?.message.content?.trim() || "The approved procedure does not provide a complete answer to that question.";
    }
    const citations = groundedChunks.map((chunk) => `• ${chunk.documentId}: ${chunk.title} — ${chunk.section} (v${chunk.version})`).join("\n");
    return `${answer}\n\nSources:\n${citations}`;
  }
}
