import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import JSZip from 'jszip';
import { PresentationStore } from '../src/storage.mjs';
import { template, profile, admin, member, deck } from './fixture.mjs';
const enabled = process.env.PRESENTATION_TEST_MONGO === '1';
test('real Mongo: upload, planning, render and download enforce team, owner, version and expiry', { skip: !enabled }, async () => {
  // Fixed loopback-only fixture. Never use a deployment URI from the environment.
  const client = new MongoClient('mongodb://127.0.0.1:27018', { serverSelectionTimeoutMS: 2000 });
  const db = client.db(`presentation_test_${randomUUID().replaceAll('-', '')}`);
  await client.connect();
  try {
    const store = new PresentationStore(db, { publicUrl: 'https://example.test/apps/presentations' }); await store.initialize();
    const bytes = await (await template()).generateAsync({ type: 'nodebuffer' });
    const input = { name: 'Example template', owner_team: 'example-team', shared_with: [], profile };
    await assert.rejects(store.upload(member, input, bytes), /administration/);
    const item = await store.upload(admin, input, bytes);
    assert.equal((await store.list(member))[0].is_default, false);
    store.defaultTemplateId = item.id;
    assert.equal((await store.list(member))[0].is_default, true);
    assert.equal((await store.list(member)).length, 1);
    const stranger = { subject: 'other-user', teams: new Map() };
    assert.equal((await store.list(stranger)).length, 0);
    await assert.rejects(store.get(stranger, item.id), /not found/);
    const request = { template_id: item.id, version: item.version, deck };
    assert.equal((await store.plan(member, request)).slide_count, 3);
    await assert.rejects(store.render(member, request)); // explicit approval is required
    const rendered = await store.render(member, { ...request, approved: true });
    assert.match(rendered.download_url, /^https:\/\/example.test\/apps\/presentations\/artifacts\//);
    const artifact = await store.download(member, rendered.artifact_id);
    const output = await JSZip.loadAsync(artifact.bytes.buffer);
    assert.match(await output.file('ppt/slides/slide2.xml').async('string'), /fixture marker/);
    await assert.rejects(store.download({ ...member, subject: 'other-user' }, rendered.artifact_id), /not found/);
    await assert.rejects(store.download({ ...member, teams: new Map() }, rendered.artifact_id), /not found/);
    await assert.rejects(store.render(member, { ...request, version: '0'.repeat(64), approved: true }), /changed/);
    await db.collection('presentation_artifacts').updateOne({ _id: rendered.artifact_id }, { $set: { expires_at: new Date(0) } });
    await assert.rejects(store.download(member, rendered.artifact_id), /expired/);
  } finally { await db.dropDatabase(); await client.close(); }
});
