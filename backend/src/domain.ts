export type VisitState = "collecting" | "ready_for_review" | "validated" | "cancelled";
export type MessageKind = "text" | "audio" | "correction" | "procedural_question" | "validation";
export type ProcessingStatus = "accepted" | "pending" | "completed" | "failed";

export interface User {
  id: string;
  displayName: string;
  role: "regional_manager";
  storeIds: string[];
}

export interface Store {
  id: string;
  name: string;
  city: string;
  timezone: string;
}

export interface Message {
  id: string;
  providerKey: string;
  actorId: string;
  visitId?: string;
  kind: MessageKind;
  text?: string;
  audioPath?: string;
  transcript?: string;
  processingStatus: ProcessingStatus;
  processingError?: string;
  receivedAt: string;
}

export interface Finding {
  id: string;
  category: "front_area" | "interior_display" | "backroom" | "equipment" | "team" | "other";
  kind: "positive" | "issue" | "neutral";
  text: string;
  sourceMessageIds: string[];
}

export interface ReportDraft {
  version: number;
  title: string;
  summary: string;
  findings: Finding[];
  followUpNotes: Array<{ text: string; sourceMessageIds: string[] }>;
  sourceMessageIds: string[];
}

export interface Visit {
  id: string;
  storeId: string;
  authorId: string;
  state: VisitState;
  startedAt: string;
  draft?: ReportDraft;
  validatedAt?: string;
  validatedBy?: string;
}

export function canAccessStore(user: User, storeId: string): boolean {
  return user.storeIds.includes(storeId);
}

export function canMutateVisit(user: User, visit: Visit): boolean {
  return visit.authorId === user.id && canAccessStore(user, visit.storeId);
}

export function canReadVisit(user: User, visit: Visit): boolean {
  return canAccessStore(user, visit.storeId) && (visit.authorId === user.id || visit.state === "validated");
}

export function validateDraft(user: User, visit: Visit, version: number, now: string): Visit {
  if (!canMutateVisit(user, visit)) throw new Error("FORBIDDEN");
  if (!visit.draft || visit.state !== "ready_for_review") throw new Error("DRAFT_NOT_READY");
  if (visit.draft.version !== version) throw new Error("STALE_DRAFT");
  return { ...visit, state: "validated", validatedAt: now, validatedBy: user.id };
}
