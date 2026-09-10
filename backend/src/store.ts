import type { Message, ReportDraft, Store, User, Visit } from "./domain.js";

export interface ValidatedReportSnapshot {
  visitId: string;
  draftId: string;
  version: number;
  report: ReportDraft;
  validatedBy: string;
  validatedAt: string;
  validationMessageId?: string;
}

export interface DataRepository {
  getUser(id: string): Promise<User>;
  getUserByAuthId(authUserId: string): Promise<User>;
  getStores(): Promise<Store[]>;
  getVisibleVisits(user: User): Promise<Visit[]>;
  getVisit(id: string): Promise<Visit | undefined>;
  getVisitMessages(visitId: string): Promise<Message[]>;
  getUnassignedMessagesForUser(userId: string): Promise<Message[]>;
  getActiveVisit(userId: string): Promise<Visit | undefined>;
  getMessageByProviderKey(providerKey: string): Promise<Message | undefined>;
  getMessage(id: string): Promise<Message | undefined>;
  insertVisit(visit: Visit): Promise<void>;
  insertMessage(message: Message): Promise<void>;
  updateMessage(message: Message): Promise<void>;
  saveVisit(visit: Visit): Promise<void>;
  finalizeValidation(visit: Visit, validationMessageId?: string): Promise<void>;
}

export class MemoryStore implements DataRepository {
  readonly users: User[] = [
    { id: "user_anika", displayName: "Anika Rao", role: "regional_manager", storeIds: ["store_lyon", "store_nantes"] },
    { id: "user_noah", displayName: "Noah Bennett", role: "regional_manager", storeIds: ["store_lille"] }
  ];
  readonly stores: Store[] = [
    { id: "store_lyon", name: "Atlas Lyon Centre", city: "Lyon", timezone: "Europe/Paris" },
    { id: "store_nantes", name: "Atlas Nantes République", city: "Nantes", timezone: "Europe/Paris" },
    { id: "store_lille", name: "Atlas Lille Flandres", city: "Lille", timezone: "Europe/Paris" }
  ];
  readonly visits: Visit[] = [];
  readonly messages: Message[] = [];
  readonly validatedReports: ValidatedReportSnapshot[] = [];

  async getUser(id: string): Promise<User> {
    const user = this.users.find((item) => item.id === id);
    if (!user) throw new Error("UNKNOWN_USER");
    return user;
  }

  async getUserByAuthId(authUserId: string): Promise<User> {
    // The in-memory adapter is only used by the local test runner.
    return this.getUser(authUserId.replace(/^auth_/, ""));
  }

  async getStores(): Promise<Store[]> {
    return this.stores;
  }

  async getVisibleVisits(user: User): Promise<Visit[]> {
    return this.visits.filter((visit) => user.storeIds.includes(visit.storeId) && (visit.authorId === user.id || visit.state === "validated"));
  }

  async getVisit(id: string): Promise<Visit | undefined> {
    return this.visits.find((visit) => visit.id === id);
  }

  async getVisitMessages(visitId: string): Promise<Message[]> {
    return this.messages.filter((message) => message.visitId === visitId).sort((left, right) => left.receivedAt.localeCompare(right.receivedAt));
  }

  async getUnassignedMessagesForUser(userId: string): Promise<Message[]> {
    return this.messages.filter((message) => message.actorId === userId && !message.visitId).sort((left, right) => left.receivedAt.localeCompare(right.receivedAt));
  }

  async getActiveVisit(userId: string): Promise<Visit | undefined> {
    return this.visits.find((visit) => visit.authorId === userId && ["collecting", "ready_for_review"].includes(visit.state));
  }

  async getMessageByProviderKey(providerKey: string): Promise<Message | undefined> {
    return this.messages.find((message) => message.providerKey === providerKey);
  }

  async getMessage(id: string): Promise<Message | undefined> {
    return this.messages.find((message) => message.id === id);
  }

  async insertVisit(visit: Visit): Promise<void> { this.visits.push(visit); }
  async insertMessage(message: Message): Promise<void> { this.messages.push(message); }
  async updateMessage(message: Message): Promise<void> {
    const index = this.messages.findIndex((item) => item.id === message.id);
    if (index < 0) throw new Error("MESSAGE_NOT_FOUND");
    this.messages[index] = message;
  }
  async saveVisit(visit: Visit): Promise<void> {
    const index = this.visits.findIndex((item) => item.id === visit.id);
    if (index < 0) throw new Error("VISIT_NOT_FOUND");
    this.visits[index] = visit;
  }

  async finalizeValidation(visit: Visit, validationMessageId?: string): Promise<void> {
    if (!visit.draft || visit.state !== "validated" || !visit.validatedBy || !visit.validatedAt) throw new Error("DRAFT_NOT_READY");
    const index = this.visits.findIndex((item) => item.id === visit.id);
    if (index < 0) throw new Error("VISIT_NOT_FOUND");
    const existing = this.validatedReports.find((report) => report.visitId === visit.id);
    if (existing) {
      if (existing.version === visit.draft.version && existing.validationMessageId === validationMessageId) return;
      throw new Error("VISIT_FINAL");
    }
    this.visits[index] = structuredClone(visit);
    this.validatedReports.push({
      visitId: visit.id,
      draftId: visit.id + ":draft:" + visit.draft.version,
      version: visit.draft.version,
      report: structuredClone(visit.draft),
      validatedBy: visit.validatedBy,
      validatedAt: visit.validatedAt,
      validationMessageId
    });
  }
}
