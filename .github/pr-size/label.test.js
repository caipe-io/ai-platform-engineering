// Run with: node --test .github/pr-size/label.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { bucketFor, countChangedLines, isGenerated } = require('./label.js');

test('bucket boundaries follow the configured minimums', () => {
  const cases = [
    [0, 'size/XS'],
    [9, 'size/XS'],
    [10, 'size/S'],
    [29, 'size/S'],
    [30, 'size/M'],
    [99, 'size/M'],
    [100, 'size/L'],
    [499, 'size/L'],
    [500, 'size/XL'],
    [999, 'size/XL'],
    [1000, 'size/XXL'],
    [250000, 'size/XXL'],
  ];
  for (const [lines, expected] of cases) {
    assert.equal(bucketFor(lines).name, expected, `${lines} lines`);
  }
});

test('lockfiles and snapshots are generated', () => {
  for (const path of [
    'uv.lock',
    'ui/package-lock.json',
    'ai_platform_engineering/mcp/example/uv.lock',
    'charts/example/Chart.lock',
    'ui/src/components/__snapshots__/button.test.tsx.snap',
    'ui/src/__snapshots__/nested/output.txt',
  ]) {
    assert.ok(isGenerated(path), path);
  }
});

test('chart docs from the generator are generated', () => {
  for (const path of [
    'charts/example/README.md',
    'charts/example/charts/sub/README.md',
    'docs/docs/installation/helm-charts/example/sub.md',
  ]) {
    assert.ok(isGenerated(path), path);
  }
});

test('hand-written files still count', () => {
  for (const path of [
    'README.md',
    'ui/package.json',
    'charts/example/values.yaml',
    'charts/example/charts/sub/scripts/README.md',
    'docs/docs/installation/helm-charts.md',
    'docs/docs/repo-ops/code-review.md',
    'ui/src/snapshot.ts',
  ]) {
    assert.ok(!isGenerated(path), path);
  }
});

test('a pull request with only generated files counts zero lines', () => {
  const files = [
    { filename: 'ui/package-lock.json', additions: 4000, deletions: 3000 },
    { filename: 'uv.lock', additions: 20, deletions: 5 },
  ];
  assert.equal(countChangedLines(files), 0);
  assert.equal(bucketFor(countChangedLines(files)).name, 'size/XS');
});

test('additions and deletions of hand-written files are summed', () => {
  const files = [
    { filename: 'ui/src/app/page.tsx', additions: 300, deletions: 150 },
    { filename: 'ui/package-lock.json', additions: 900, deletions: 0 },
    { filename: 'ui/src/lib/util.ts', additions: 40, deletions: 20 },
  ];
  assert.equal(countChangedLines(files), 510);
  assert.equal(bucketFor(510).name, 'size/XL');
});

test('renaming handwritten code into an excluded path still counts its changes', () => {
  assert.equal(countChangedLines([{ filename: 'test/example.snap',
    previous_filename: 'src/example.js', additions: 10, deletions: 20 }]), 30);
});
