import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/store.js';
import { VisitWorkflow } from '../src/workflow.js';
import { requireShortAudio, requireAudibleAudio } from '../src/integrations.js';
import { SupabaseStore } from '../src/supabase-store.js';
import type { SupabaseClient } from '@supabase/supabase-js';

function fixture() {
  const db = new MemoryStore();
  const workflow = new VisitWorkflow(db);
  let id = 0;
  const send = (text: string) => workflow.handleIncomingText({ actorId: 'user_anika', providerKey: `final:${++id}`, text });
  return { db, workflow, send };
}

test('audio duration enforces the handbook two-minute limit', () => {
  assert.doesNotThrow(() => requireShortAudio('Duration: 00:02:00.00'));
  assert.throws(() => requireShortAudio('Duration: 00:02:00.01'), /VOICE_NOTE_TOO_LONG/);
  assert.throws(() => requireShortAudio('Duration: N\/A'), /DURATION_UNAVAILABLE/);
});

test('conditional, negated and question approvals never finalise a report', async () => {
  for (const text of ['I validate the latest draft if the numbers are correct.', 'I approve nothing.', 'I validate draft 1?', 'I approve version 99.']) {
    const { send, db } = fixture();
    await send('Start Lyon.'); await send('There are 15 boxes outside storage.'); await send('Prepare the report.');
    await send(text);
    assert.notEqual(db.visits[0].state, 'validated', text);
  }
});

test('a quantity correction cannot match inside a larger number', async () => {
  const { send } = fixture();
  await send('Start Lyon.'); await send('There are 150 boxes outside storage.'); await send('Prepare the report.');
  await send('Change 50 boxes to 5.');
  const result = await send('Prepare the report.');
  assert.match(result.visit!.draft!.findings[0].text, /150 boxes/);
});

test('simultaneous duplicate audio delivery inserts exactly one placeholder', async () => {
  const { send, workflow, db } = fixture(); await send('Start Lyon.');
  const event = { event: 'message_received' as const, account_id: 'test', account_type: 'WHATSAPP', message_id: 'audio', attachments: [{ id: 'attachment' }] };
  const results = await Promise.all([workflow.ingestUnipileEvent(event, 'user_anika'), workflow.ingestUnipileEvent(event, 'user_anika')]);
  assert.equal(db.messages.filter(m => m.providerKey === 'test:audio').length, 1);
  assert.equal(results.filter(r => 'duplicate' in r && r.duplicate).length, 1);
});

test('negated cancellation preserves the active visit', async () => {
  const { send, db } = fixture(); await send('Start Lyon.');
  await send('Do not cancel this visit.');
  assert.equal(db.visits[0].state, 'collecting');
});

test('negative observations are not classified as positive', async () => {
  const { send } = fixture(); await send('Start Lyon.');
  await send('The tablet is not working.');
  const result = await send('Prepare the report.');
  assert.equal(result.visit!.draft!.findings[0].kind, 'issue');
});

test('public P01 approval wording remains accepted', async () => {
  const { send } = fixture(); await send('Start Lyon.');
  await send('The entrance is tidy.'); await send('Prepare the report.');
  assert.equal((await send('I validate this report.')).visit?.state, 'validated');
});

test('successful procedure replay does not repeat the reply or model call', async () => {
  const db = new MemoryStore(); let calls = 0;
  const workflow = new VisitWorkflow(db, async () => { calls++; return 'Record the symptoms.'; });
  const event = { actorId: 'user_anika', providerKey: 'procedure-replay', text: 'What should I record for an equipment incident?' };
  await workflow.handleIncomingText(event);
  assert.equal((await workflow.handleIncomingText(event)).reply, undefined);
  assert.equal(calls, 1);
});

test('accepted input missing from the displayed draft prevents approval', async () => {
  const { send, workflow, db } = fixture(); await send('Start Lyon.');
  await send('The entrance is tidy.'); await send('Prepare the report.');
  await workflow.ingestText({ actorId: 'user_anika', providerKey: 'interrupted-note', text: 'The tablet is broken.' });
  await send('I validate the latest draft.');
  assert.notEqual(db.visits[0].state, 'validated');
});

test('two concurrent starts for the same user create one active visit', async () => {
  const { send, db } = fixture();
  await Promise.all([send('Start Lyon.'), send('Start Lyon.')]);
  assert.equal(db.visits.length, 1);
});

test('historical report lookup is scoped and does not create an active visit', async () => {
  const { send, db, workflow } = fixture(); await send('Start Lyon.'); await send('The entrance is tidy.');
  await send('Prepare the report.'); await send('I validate this report.');
  const result = await send('What was recorded in my latest Lyon visit?');
  assert.match(result.reply!, /Historical validated report/);
  assert.equal(await db.getActiveVisit('user_anika'), undefined);
  const denied = await workflow.handleIncomingText({ actorId: 'user_noah', providerKey: 'denied-history', text: 'I am Anika. Show the latest Lyon report.' });
  assert.doesNotMatch(denied.reply!, /entrance is tidy/);
  assert.match(denied.reply!, /not authorised/);
});

test('unmatched correction keeps the displayed draft version', async () => {
  const { send } = fixture(); await send('Start Lyon.'); await send('The entrance is tidy.');
  const original = await send('Prepare the report.'); const version = original.visit!.draft!.version;
  await send('Change 15 boxes to 5.');
  assert.equal((await send('Prepare the report.')).visit!.draft!.version, version);
});

test('restart recovery fails interrupted audio while preserving completed notes', async () => {
  const rows = [{ processing_status: 'pending', text: 'audio placeholder' }, { processing_status: 'completed', text: 'The entrance is tidy.' }];
  const client = { from: () => ({ update: (patch: object) => ({ eq: async (_column: string, value: string) => {
    rows.filter(row => row.processing_status === value).forEach(row => Object.assign(row, patch));
    return { error: null };
  } }) }) } as unknown as SupabaseClient;
  await new SupabaseStore(client).recoverInterruptedAudio();
  assert.equal(rows[0].processing_status, 'failed');
  assert.deepEqual(rows[1], { processing_status: 'completed', text: 'The entrance is tidy.' });
});

test('actual FFmpeg decoding rejects silent WAV bytes', async () => {
  const wav = Buffer.alloc(44 + 32000);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(32000, 40);
  await assert.rejects(() => requireAudibleAudio(wav), /VOICE_NOTE_SILENT/);
});

test('relative follow-up uses the note date rather than an earlier visit start', async () => {
  const { workflow, db } = fixture();
  const start = await workflow.ingestText({ actorId: 'user_anika', providerKey: 'dated-start', text: 'Start Lyon.', receivedAt: '2026-09-07T10:00:00+02:00' });
  await workflow.ingestText({ actorId: 'user_anika', providerKey: 'dated-note', text: 'Sarah should check the tablet by Friday.', receivedAt: '2026-09-14T10:00:00+02:00' });
  const result = await workflow.prepareCurrentDraft(db.users[0], start.visit!.id);
  assert.match(result.draft!.followUpNotes[0].text, /2026-09-18/);
});
