import type { Finding, Message, ReportDraft, Store, Visit } from "./domain.js";

type Observation = { text: string; sourceMessageIds: string[] };

const numberWords: Record<string, string> = {
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10",
  eleven: "11", twelve: "12", thirteen: "13", fourteen: "14", fifteen: "15", sixteen: "16", seventeen: "17", eighteen: "18", nineteen: "19", twenty: "20"
};

function normalizeNumbers(value: string): string {
  return value.toLowerCase().replace(/\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|\d+)\b/g, (token) => numberWords[token] ?? token);
}

export function isCorrectionInstruction(text: string): boolean {
  const value = text.trim();
  return /^(?:change|correct|replace)\b/i.test(value)
    || /^(?:change|correct|replace)\s*:/i.test(value)
    || /\bplease\s+(?:change|correct|replace|remove)\b/i.test(value)
    || /\bremove\s+(?:it|that|this)\b/i.test(value)
    || /^(?:remove|delete)\b/i.test(value)
    || /^(?:remove|delete)\s*:/i.test(value)
    || /\bcorrection to (?:my )?previous note\b/i.test(value)
    || /\bi said\b.*\bnot\b/i.test(value)
    || /\bplease use\b.*\bnot\b/i.test(value);
}

function observationSentences(message: Message): string[] {
  const text = message.transcript ?? message.text ?? "";
  return text.split(/(?<=[.!?])\s+/).map((sentence) => sentence.trim()).map((sentence) => sentence
    .replace(/^(?:i am |i'm )?(?:start(?:ing)?|begin(?:ning)?)\s+(?:a )?visit(?:\s+to\s+[^.!?]+)?\s*[,;:-]?\s*/i, "")
    .replace(/^(?:now\s+)?i am at (?:lyon|nantes|lille)[.!]?$/i, "")
  ).filter((sentence) => {
    const lower = sentence.toLowerCase()
      .replace(/^[\s'"“”‘’`]+|[\s'"“”‘’`.,!?]+$/g, "")
      .trim();
    const isCommand = /^(?:lyon|nantes|lille)$|^(?:start|starting|begin|beginning).*\bvisit\b|^(?:cancel|abandon).*\b(?:start|switch)\b|^(?:prepare|show|finish|end)\b.*\b(?:report|draft|visit)\b|^(?:review|check)\b.*\b(?:revised facts|draft|report)\b|^(?:finish|end|done|cancel|abandon)$|^(?:i\s+)?(?:validate|approve)\b|^(?:change|remove|replace|correct)\b/.test(lower);
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
  const removalMatch = /^(?:remove|delete)\s*:\s*(.+?)[.!?]?$/i.exec(text);
  const naturalRemovalMatch = /^(?:remove|delete)\s+(?:(?:the|this)\s+)?(.+?)(?:\s+only)?[.!?]?$/i.exec(text);
  if (removalMatch || naturalRemovalMatch) {
    const normalize = (value: string) => value.trim().replace(/^['"]|['"]$/g, "").replace(/[.!?]+$/, "").toLowerCase();
    const target = normalize(removalMatch?.[1] ?? naturalRemovalMatch![1]).replace(/[-_]/g, " ");
    const exactIndex = observations.findIndex((observation) => normalize(observation.text) === target);
    if (exactIndex >= 0) {
      observations.splice(exactIndex, 1);
      return;
    }
    const ignored = new Set(["a", "an", "the", "this", "that", "observation", "finding", "sentence", "issue", "only", "about", "from", "was", "another", "store"]);
    const targetWords = target.split(/\s+/).filter((word) => word.length > 2 && !ignored.has(word));
    const candidates = observations.map((observation, index) => ({ index, words: normalize(observation.text).replace(/[-_]/g, " ").split(/\s+/) }))
      .filter((candidate) => targetWords.length > 0 && targetWords.every((word) => candidate.words.includes(word)));
    if (candidates.length === 1) observations.splice(candidates[0].index, 1);
    return;
  }
  const directMatch = /^(?:change|correct|replace)\s*:?[\s]+(.+?)\s+(?:to|with)\s+(.+?)[.!?]?$/i.exec(text);
  const spokenQuantityMatch = /(?:there\s+(?:are|is)\s+)?(?<replacement>\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\s+(?<unit>boxes?|items?|units?|pieces?)[^.!?]*?,\s*not\s+(?<previous>\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b/i.exec(text);
  if (!directMatch && !spokenQuantityMatch) return;

  const previous = spokenQuantityMatch?.groups?.previous?.trim() ?? directMatch![1].trim();
  let replacement = spokenQuantityMatch?.groups?.replacement?.trim() ?? directMatch![2].trim();
  // Users naturally say "change fifteen boxes to five". Keep the unit so
  // the revised finding remains understandable on its own.
  const unit = spokenQuantityMatch?.groups?.unit ?? /\b(box(?:es)?|item(?:s)?|unit(?:s)?|piece(?:s)?)$/i.exec(previous)?.[1];
  if (!spokenQuantityMatch && unit && /^\d+(?:\.\d+)?$|^(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)$/i.test(replacement)) {
    replacement = `${replacement} ${unit}`;
  }

  const numericPhrase = /\b(?<number>\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\s+(?<numericUnit>boxes?|items?|units?|pieces?)\b/i.exec(previous);
  const numericToken = numericPhrase?.groups?.number;
  const numericUnit = numericPhrase?.groups?.numericUnit;
  const variants = numericToken && numberWords[numericToken.toLowerCase()]
    ? `${escapePattern(numericToken)}|${numberWords[numericToken.toLowerCase()]}`
    : numericToken && /^\d+$/.test(numericToken)
      ? `${escapePattern(numericToken)}|${Object.entries(numberWords).find(([, value]) => value === numericToken)?.[0] ?? escapePattern(numericToken)}`
      : undefined;
  const expression = variants && numericUnit
    ? new RegExp(`(?:${variants})\\s+${escapePattern(numericUnit)}`, "i")
    : new RegExp(escapePattern(previous), "i");
  for (let index = observations.length - 1; index >= 0; index -= 1) {
    const candidate = observations[index];
    if (!normalizeNumbers(candidate.text).includes(normalizeNumbers(previous))) continue;
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
    if (message.kind === "procedural_question" || message.kind === "validation") continue;
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
