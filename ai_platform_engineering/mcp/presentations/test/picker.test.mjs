import test from 'node:test';
import assert from 'node:assert/strict';
import { rankTeams, teamLabel, teamDescription } from '../src/picker.mjs';
import { resolveUploadProfile } from '../src/server.mjs';

test('team matching ranks exact identities, searches every token and bounds large directories', () => {
  const teams = Array.from({ length: 4500 }, (_, i) => ({ slug: 'example-team-' + i, name: 'Example team ' + i }));
  teams.push({ slug: 'platform-operations', name: 'Platform operations' }, { slug: 'secondary-platform', name: 'Plátform review' });
  assert.equal(rankTeams(teams, 'EXAMPLE_team_4499').options[0].slug, 'example-team-4499');
  assert.equal(rankTeams(teams, 'example team').options.length, 20);
  assert.equal(rankTeams(teams, 'example team').total, 4500);
  assert.equal(rankTeams(teams, 'operations platform').options[0].slug, 'platform-operations');
  assert.equal(rankTeams(teams, 'platform review').options[0].slug, 'secondary-platform');
  assert.deepEqual(rankTeams(teams, '').options, []);
  assert.equal(rankTeams(teams, '', ['platform-operations']).options[0].slug, 'platform-operations');
  assert.equal(rankTeams(teams, 'unmatched').total, 0);
});

test('team labels avoid duplicate slug rows but preserve identity when names collide', () => {
  assert.equal(teamLabel({ slug: 'example-team', name: 'Example Team' }), 'Example Team');
  assert.equal(teamDescription({ slug: 'example-team', name: 'Example Team' }), '');
  assert.equal(teamDescription({ slug: 'example-team' }), '');
  assert.equal(teamDescription({ slug: 'primary-team', name: 'Engineering' }), 'primary-team');
});

test('upload mapping uses configured defaults, supports legacy explicit callers and rejects ambiguity', () => {
  const profiles = [{ id: 'primary' }, { id: 'secondary' }];
  assert.equal(resolveUploadProfile(profiles, 'secondary').id, 'secondary');
  assert.equal(resolveUploadProfile([profiles[0]]).id, 'primary');
  assert.equal(resolveUploadProfile(profiles, 'secondary', 'primary').id, 'primary');
  assert.throws(() => resolveUploadProfile(profiles), /administrator/);
  assert.throws(() => resolveUploadProfile(profiles, 'secondary', 'unknown'), /Unknown/);
});
