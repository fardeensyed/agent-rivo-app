import type { Finding, Message, ReportDraft, Store, Visit } from "./domain.js";

type Observation = { text: string; sourceMessageIds: string[] };

export function isCorrectionInstruction(text: string): boolean {
  return /^(?:change|correct|replace)\b/i.test(text.trim());
}

function observationSentences(message: Message): string[] {
  const text = message.transcript ?? message.text ?? "";
  return text.split(/(?<=[.!?])\s+/).map((sentence) => sentence.trim()).filter((sentence) => {
    const lower = sentence.toLowerCase();
    const isCommand = /^(start|begin).*(visit)|^(prepare|show|finish|end).*(report|draft|visit)|^(finish|end|done)\.?$|^(i )?(validate|approve)|^(change|remove|replace|correct)\b/.test(lower);
    return sentence.length > 2 && !isCommand;
  });
}

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Converts concise field corrections into an auditable change to the prior
 * factual observation. Example: "change fifteen boxes to five" updates
 * "Fifteen boxes are outside storage" to "five boxes are outside storage".
 */
function applyCorrection(observations: Observation[], message: Message): void {
  const text = (message.transcript ?? message.text ?? "").trim();
  const match = /^(?:change|correct|replace)\s+(.+?)\s+(?:to|with)\s+(.+?)[.!?]?$/i.exec(text);
  if (!match) return;

  const previous = match[1].trim();
  let replacement = match[2].trim();
  // Users naturally say "change fifteen boxes to five". Keep the unit so
  // the revised finding remains understandable on its own.
  const unit = /\b(box(?:es)?|item(?:s)?|unit(?:s)?|piece(?:s)?)$/i.exec(previous)?.[1];
  if (unit && /^\d+(?:\.\d+)?$|^(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)$/i.test(replacement)) {
    replacement = `${replacement} ${unit}`;
  }

  const expression = new RegExp(escapePattern(previous), "i");
  for (let index = observations.length - 1; index >= 0; index -= 1) {
    const candidate = observations[index];
    if (!expression.test(candidate.text)) continue;
    candidate.text = candidate.text.replace(expression, replacement);
    candidate.sourceMessageIds = Array.from(new Set([...candidate.sourceMessageIds, message.id]));
    return;
  }
}

function categoryFor(text: string): Finding["category"] {
  const lower = text.toLowerCase();
  if (/box|stock|backroom|delivery|shelf/.test(lower)) return "backroom";
  if (/tablet|printer|equipment|charg|software|wifi|connectivity/.test(lower)) return "equipment";
  if (/employee|staff|team|manager|absence|absent/.test(lower)) return "team";
  if (/entrance|front area/.test(lower)) return "front_area";
  if (/display|poster|label|sign|promotion/.test(lower)) return "interior_display";
  return "other";
}

function kindFor(text: string): Finding["kind"] {
  const lower = text.toLowerCase();
  if (/tidy|clean|up to date|works|working|correctly installed/.test(lower)) return "positive";
  if (/missing|outdated|broken|damaged|not charg|does not|doesn't|absent|outside/.test(lower)) return "issue";
  return "neutral";
}

function isFollowUp(text: string): boolean {
  return /\b(should|please|ask|check .* with|by (monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i.test(text);
}

export function buildFactualDraft(visit: Visit, store: Store, messages: Message[]): ReportDraft {
  const observations: Observation[] = [];
  for (const message of messages) {
    if (message.processingStatus === "failed" || message.processingStatus === "pending") continue;
    if (message.kind === "correction" || isCorrectionInstruction(message.text ?? message.transcript ?? "")) {
      applyCorrection(observations, message);
      continue;
    }
    observations.push(...observationSentences(message).map((text) => ({ text, sourceMessageIds: [message.id] })));
  }
  const findings: Finding[] = observations.filter((item) => !isFollowUp(item.text)).map((item, index) => ({
    id: `draft-${visit.id}-finding-${index + 1}`,
    category: categoryFor(item.text),
    kind: kindFor(item.text),
    text: item.text,
    sourceMessageIds: item.sourceMessageIds
  }));
  const followUpNotes = observations.filter((item) => isFollowUp(item.text)).map((item) => ({ text: item.text, sourceMessageIds: item.sourceMessageIds }));
  const sourceMessageIds = Array.from(new Set([...findings.flatMap((finding) => finding.sourceMessageIds), ...followUpNotes.flatMap((note) => note.sourceMessageIds)]));
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: store.timezone }).format(new Date(visit.startedAt));
  return {
    version: (visit.draft?.version ?? 0) + 1,
    title: `${store.name} — Visit report — ${date}`,
    summary: findings.slice(0, 3).map((finding) => finding.text).join(" ") || "No factual observations have been accepted yet.",
    findings,
    followUpNotes,
    sourceMessageIds
  };
}
