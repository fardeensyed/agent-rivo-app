import type { Finding, Message, ReportDraft, Store, Visit } from "./domain.js";

function observationSentences(message: Message): string[] {
  const text = message.transcript ?? message.text ?? "";
  return text.split(/(?<=[.!?])\s+/).map((sentence) => sentence.trim()).filter((sentence) => {
    const lower = sentence.toLowerCase();
    const isCommand = /^(start|begin).*(visit)|^(prepare|show|finish|end).*(report|draft|visit)|^(finish|end|done)\.?$|^(i )?(validate|approve)|^(change|remove|replace|correct)\b/.test(lower);
    return sentence.length > 2 && !isCommand;
  });
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
  const observations = messages.flatMap((message) => observationSentences(message).map((text) => ({ text, sourceMessageId: message.id })));
  const findings: Finding[] = observations.filter((item) => !isFollowUp(item.text)).map((item, index) => ({
    id: `draft-${visit.id}-finding-${index + 1}`,
    category: categoryFor(item.text),
    kind: kindFor(item.text),
    text: item.text,
    sourceMessageIds: [item.sourceMessageId]
  }));
  const followUpNotes = observations.filter((item) => isFollowUp(item.text)).map((item) => ({ text: item.text, sourceMessageIds: [item.sourceMessageId] }));
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
