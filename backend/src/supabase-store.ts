import type { SupabaseClient } from "@supabase/supabase-js";
import type { Message, ReportDraft, Store, User, Visit } from "./domain.js";
import type { DataRepository } from "./store.js";

type Row = Record<string, unknown>;

export class SupabaseStore implements DataRepository {
  constructor(private readonly client: SupabaseClient) {}

  async getUser(id: string): Promise<User> {
    const { data, error } = await this.client.from("app_users").select("id,display_name,role").eq("id", id).single();
    if (error || !data) throw new Error("UNKNOWN_USER");
    const { data: memberships, error: membershipError } = await this.client.from("user_store_memberships").select("store_id").eq("user_id", id);
    if (membershipError) throw new Error(`USER_SCOPE_READ_FAILED:${membershipError.message}`);
    return { id: String(data.id), displayName: String(data.display_name), role: "regional_manager", storeIds: (memberships ?? []).map((row) => String(row.store_id)) };
  }

  async getUserByAuthId(authUserId: string): Promise<User> {
    const { data, error } = await this.client.from("app_users").select("id").eq("auth_user_id", authUserId).maybeSingle();
    if (error || !data) throw new Error("AUTH_USER_NOT_MAPPED");
    return this.getUser(String(data.id));
  }

  async getStores(): Promise<Store[]> {
    const { data, error } = await this.client.from("stores").select("id,name,city,timezone");
    if (error) throw new Error(`STORE_READ_FAILED:${error.message}`);
    return (data ?? []).map((row) => ({ id: String(row.id), name: String(row.name), city: String(row.city), timezone: String(row.timezone) }));
  }

  async getVisibleVisits(user: User): Promise<Visit[]> {
    const { data, error } = await this.client.from("visits").select("*").or(`author_id.eq.${user.id},store_id.in.(${user.storeIds.join(",")})`).order("started_at", { ascending: false });
    if (error) throw new Error(`VISIT_READ_FAILED:${error.message}`);
    return Promise.all((data ?? []).map((row) => this.toVisit(row as Row)));
  }

  async getVisit(id: string): Promise<Visit | undefined> {
    const { data, error } = await this.client.from("visits").select("*").eq("id", id).maybeSingle();
    if (error) throw new Error(`VISIT_READ_FAILED:${error.message}`);
    return data ? this.toVisit(data as Row) : undefined;
  }

  async getVisitMessages(visitId: string): Promise<Message[]> {
    const { data, error } = await this.client.from("messages").select("*").eq("visit_id", visitId).order("received_at", { ascending: true });
    if (error) throw new Error(`MESSAGE_READ_FAILED:${error.message}`);
    return (data ?? []).map((row) => this.toMessage(row as Row));
  }

  async getUnassignedMessagesForUser(userId: string): Promise<Message[]> {
    const { data, error } = await this.client.from("messages").select("*").eq("actor_id", userId).is("visit_id", null).order("received_at", { ascending: true });
    if (error) throw new Error(`MESSAGE_READ_FAILED:${error.message}`);
    return (data ?? []).map((row) => this.toMessage(row as Row));
  }

  async getActiveVisit(userId: string): Promise<Visit | undefined> {
    const { data, error } = await this.client.from("visits").select("*").eq("author_id", userId).in("state", ["collecting", "ready_for_review"]).maybeSingle();
    if (error) throw new Error(`ACTIVE_VISIT_READ_FAILED:${error.message}`);
    return data ? this.toVisit(data as Row) : undefined;
  }

  async getMessageByProviderKey(providerKey: string): Promise<Message | undefined> {
    const separator = providerKey.indexOf(":");
    const accountId = separator >= 0 ? providerKey.slice(0, separator) : "fixture";
    const messageId = separator >= 0 ? providerKey.slice(separator + 1) : providerKey;
    const { data, error } = await this.client.from("messages").select("*").eq("provider_account_id", accountId).eq("provider_message_id", messageId).maybeSingle();
    if (error) throw new Error(`MESSAGE_READ_FAILED:${error.message}`);
    return data ? this.toMessage(data as Row) : undefined;
  }

  async getMessage(id: string): Promise<Message | undefined> {
    const { data, error } = await this.client.from("messages").select("*").eq("id", id).maybeSingle();
    if (error) throw new Error(`MESSAGE_READ_FAILED:${error.message}`);
    return data ? this.toMessage(data as Row) : undefined;
  }

  async insertVisit(visit: Visit): Promise<void> {
    const { error } = await this.client.from("visits").insert({ id: visit.id, store_id: visit.storeId, author_id: visit.authorId, state: visit.state, started_at: visit.startedAt, latest_draft_version: visit.draft?.version ?? 0 });
    if (error) throw new Error(`VISIT_INSERT_FAILED:${error.message}`);
  }

  async insertMessage(message: Message): Promise<void> {
    const separator = message.providerKey.indexOf(":");
    const accountId = separator >= 0 ? message.providerKey.slice(0, separator) : "fixture";
    const providerMessageId = separator >= 0 ? message.providerKey.slice(separator + 1) : message.providerKey;
    const { error } = await this.client.from("messages").insert({ id: message.id, provider_account_id: accountId, provider_message_id: providerMessageId, visit_id: message.visitId, actor_id: message.actorId, kind: message.kind, text_content: message.text, audio_storage_path: message.audioPath, transcript: message.transcript, processing_status: message.processingStatus, received_at: message.receivedAt });
    if (error) throw new Error(`MESSAGE_INSERT_FAILED:${error.message}`);
  }

  async updateMessage(message: Message): Promise<void> {
    const { error } = await this.client.from("messages").update({
      visit_id: message.visitId,
      text_content: message.text,
      audio_storage_path: message.audioPath,
      transcript: message.transcript,
      processing_status: message.processingStatus,
      processing_error: message.processingError
    }).eq("id", message.id);
    if (error) throw new Error(`MESSAGE_UPDATE_FAILED:${error.message}`);
  }

  async saveVisit(visit: Visit): Promise<void> {
    const { error } = await this.client.from("visits").update({ state: visit.state, validated_at: visit.validatedAt, validated_by: visit.validatedBy, latest_draft_version: visit.draft?.version ?? 0 }).eq("id", visit.id);
    if (error) throw new Error(`VISIT_UPDATE_FAILED:${error.message}`);
    if (visit.draft) {
      const draft = visit.draft;
      const { error: draftError } = await this.client.from("report_drafts").upsert({ visit_id: visit.id, version: draft.version, title: draft.title, summary: draft.summary, report_json: draft, source_message_ids: draft.sourceMessageIds }, { onConflict: "visit_id,version" });
      if (draftError) throw new Error(`DRAFT_UPSERT_FAILED:${draftError.message}`);
    }
  }

  private async toVisit(row: Row): Promise<Visit> {
    const { data: draftRow } = await this.client.from("report_drafts").select("*").eq("visit_id", String(row.id)).order("version", { ascending: false }).limit(1).maybeSingle();
    const draft = draftRow?.report_json as ReportDraft | undefined;
    return { id: String(row.id), storeId: String(row.store_id), authorId: String(row.author_id), state: row.state as Visit["state"], startedAt: String(row.started_at), validatedAt: row.validated_at ? String(row.validated_at) : undefined, validatedBy: row.validated_by ? String(row.validated_by) : undefined, draft };
  }

  private toMessage(row: Row): Message {
    return { id: String(row.id), providerKey: `${row.provider_account_id}:${row.provider_message_id}`, actorId: String(row.actor_id), visitId: row.visit_id ? String(row.visit_id) : undefined, kind: row.kind as Message["kind"], text: row.text_content ? String(row.text_content) : undefined, audioPath: row.audio_storage_path ? String(row.audio_storage_path) : undefined, transcript: row.transcript ? String(row.transcript) : undefined, processingStatus: row.processing_status as Message["processingStatus"], processingError: row.processing_error ? String(row.processing_error) : undefined, receivedAt: String(row.received_at) };
  }
}
