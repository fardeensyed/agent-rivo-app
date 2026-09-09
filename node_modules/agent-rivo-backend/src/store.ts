import type { Message, Store, User, Visit } from "./domain.js";

export class MemoryStore {
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

  user(id: string): User {
    const user = this.users.find((item) => item.id === id);
    if (!user) throw new Error("UNKNOWN_USER");
    return user;
  }

  activeVisit(userId: string): Visit | undefined {
    return this.visits.find((visit) => visit.authorId === userId && ["collecting", "ready_for_review"].includes(visit.state));
  }

  messageByProviderKey(providerKey: string): Message | undefined {
    return this.messages.find((message) => message.providerKey === providerKey);
  }
}
