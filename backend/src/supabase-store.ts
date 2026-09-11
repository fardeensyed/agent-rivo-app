import type { SupabaseClient } from "@supabase/supabase-js";
import type { Message, ReportDraft, Store, User, Visit } from "./domain.js";
import type { DataRepository } from "./store.js";

type Row = Record<string, unknown>;

export class SupabaseStore implements DataRepository {
  constructor(private readonly client: SupabaseClient) {}

  // This prototype runs one backend process. At boot no prior audio worker is
  // still alive; release interrupted placeholders so they cannot block a visit.
  async recoverInterruptedAudio(): Promise<void> {
    const { error } = await this.client.from("messages").update({
      processing_status: "failed",
      processing_error: "PROCESSING_INTERRUPTED: Please resend the voice note or send text."
    }).eq("processing_status", "pending");
    if (error) throw new Error("AUDIO_RECOVERY_FAILED:" + error.message);
  }

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
    const { data, error } = await this.client.from("visits").select("*").order("started_at", { ascending: false });
    if (error) throw new Error(`VISIT_READ_FAILED:${error.message}`);
    const visits = await Promise.all((data ?? []).map((row) => this.toVisit(row as Row)));
    return visits.filter((visit) => user.storeIds.includes(visit.storeId) && (visit.authorId === user.id || visit.state === "validated"));
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
      kind: message.kind,
      text_content: message.text,
      audio_storage_path: message.audioPath,
      transcript: message.transcript,
      processing_status: message.processingStatus,
      processing_error: message.processingError
    }).eq("id", message.id);
    if (error) throw new Error(`MESSAGE_UPDATE_FAILED:${error.message}`);
  }

  async saveVisit(visit: Visit): Promise<void> {
    if (visit.state === "validated") throw new Error("VALIDATION_MUST_USE_SNAPSHOT");
    const draft = visit.draft;
    const { error } = await this.client.rpc("save_visit_state_and_draft", {
      p_visit_id: visit.id,
      p_state: visit.state,
      p_validated_at: visit.validatedAt ?? null,
      p_validated_by: visit.validatedBy ?? null,
      p_latest_draft_version: draft?.version ?? 0,
      p_draft_version: draft?.version ?? null,
      p_title: draft?.title ?? null,
      p_summary: draft?.summary ?? null,
      p_report_json: draft ?? null,
      p_source_message_ids: draft?.sourceMessageIds ?? null
    });
    if (error) throw new Error("VISIT_SAVE_FAILED:" + error.message);
  }

  async finalizeValidation(visit: Visit, validationMessageId?: string): Promise<void> {
    if (!visit.draft || !visit.validatedAt || !visit.validatedBy) throw new Error("DRAFT_NOT_READY");
    const { error } = await this.client.rpc("finalize_visit_with_snapshot", {
      p_visit_id: visit.id,
      p_version: visit.draft.version,
      p_validated_by: visit.validatedBy,
      p_validated_at: visit.validatedAt,
      p_validation_message_id: validationMessageId ?? null
    });
    if (error) {
      if (/STALE_DRAFT/i.test(error.message)) throw new Error("STALE_DRAFT");
      if (/VISIT_FINAL/i.test(error.message)) throw new Error("VISIT_FINAL");
      if (/DRAFT_NOT_READY/i.test(error.message)) throw new Error("DRAFT_NOT_READY");
      throw new Error("VALIDATION_SNAPSHOT_FAILED:" + error.message);
    }
  }

  private async toVisit(row: Row): Promise<Visit> {
    const visitId = String(row.id);
    const isValidated = row.state === "validated";
    const { data: reportRow, error: reportError } = isValidated
      ? await this.client.from("validated_reports").select("report_json").eq("visit_id", visitId).maybeSingle()
      : { data: undefined, error: null };
    if (reportError) throw new Error("VALIDATED_REPORT_READ_FAILED:" + reportError.message);
    const { data: draftRow, error: draftError } = reportRow
      ? { data: undefined, error: null }
      : await this.client.from("report_drafts").select("*").eq("visit_id", visitId).order("version", { ascending: false }).limit(1).maybeSingle();
    if (draftError) throw new Error("DRAFT_READ_FAILED:" + draftError.message);
    const draft = (reportRow?.report_json ?? draftRow?.report_json) as ReportDraft | undefined;
    return { id: String(row.id), storeId: String(row.store_id), authorId: String(row.author_id), state: row.state as Visit["state"], startedAt: String(row.started_at), validatedAt: row.validated_at ? String(row.validated_at) : undefined, validatedBy: row.validated_by ? String(row.validated_by) : undefined, draft };
  }

  private toMessage(row: Row): Message {
    return { id: String(row.id), providerKey: `${row.provider_account_id}:${row.provider_message_id}`, actorId: String(row.actor_id), visitId: row.visit_id ? String(row.visit_id) : undefined, kind: row.kind as Message["kind"], text: row.text_content ? String(row.text_content) : undefined, audioPath: row.audio_storage_path ? String(row.audio_storage_path) : undefined, transcript: row.transcript ? String(row.transcript) : undefined, processingStatus: row.processing_status as Message["processingStatus"], processingError: row.processing_error ? String(row.processing_error) : undefined, receivedAt: String(row.received_at) };
  }
}
