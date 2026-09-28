const test = require('node:test');
const assert = require('node:assert/strict');
const { run } = require('./label.js');
const config = require('./config.json');

function fixture() {
  const labels = new Set(['bug', 'size/L']);
  const calls = [], warnings = [];
  const state = { sha: 'old', baseSha: 'base', changedFiles: 1, additions: 10 };
  const hooks = {};
  const github = {
    rest: {
      pulls: {
        get: async ({ pull_number }) => {
          calls.push(['get', pull_number]);
          return { data: { state: 'open', head: { sha: state.sha }, base: { sha: state.baseSha },
            changed_files: state.changedFiles } };
        },
        listFiles: 'files', list: 'prs',
      },
      issues: {
        listLabelsOnIssue: 'labels',
        getLabel: async ({ name }) => ({ data: config.buckets.find((b) => b.name === name) }),
        createLabel: async () => {},
        addLabels: async (args) => {
          if (hooks.add) await hooks.add(args);
          calls.push(['add', args.issue_number, ...args.labels]);
          args.labels.forEach((name) => labels.add(name));
        },
        removeLabel: async ({ name }) => { calls.push(['remove', name]); labels.delete(name); },
      },
    },
    paginate: async (endpoint, args) => {
      assert.equal(args.per_page, 100);
      calls.push(['paginate', endpoint]);
      if (endpoint === 'prs') return [{ number: 1 }, { number: 2 }];
      if (endpoint === 'labels') return [...labels].map((name) => ({ name }));
      const files = hooks.files ? await hooks.files() : [
        { filename: 'src/example.js', additions: state.additions, deletions: 0 },
      ];
      return files;
    },
  };
  const context = { repo: { owner: 'example', repo: 'example' },
    eventName: 'pull_request_target', payload: { pull_request: {
      number: 1, head: { repo: { full_name: 'untrusted/fork' } },
    } } };
  const core = { info: () => {}, warning: (message) => warnings.push(message) };
  return { github, context, core, labels, state, calls, hooks, warnings };
}

test('fork event replaces stale sizes, preserves unrelated labels, and is idempotent', async () => {
  const f = fixture();
  f.labels.add('size/obsolete');
  await run(f);
  assert.deepEqual([...f.labels], ['bug', 'size/S']);
  const mutations = f.calls.filter(([name]) => ['add', 'remove'].includes(name));
  assert.equal(mutations[0][0], 'add');
  await run(f);
  assert.deepEqual(f.calls.filter(([name]) => ['add', 'remove'].includes(name)), mutations);
  assert.deepEqual(f.warnings, []);
});

test('oversized and incomplete file lists leave existing labels unchanged', async () => {
  for (const count of [3001, 2]) {
    const f = fixture();
    f.state.changedFiles = count;
    await run(f);
    assert.deepEqual([...f.labels], ['bug', 'size/L']);
    assert.equal(f.warnings.length, 1);
    assert.equal(f.calls.some(([name]) => name === 'add' || name === 'remove'), false);
  }
});

test('a failed replacement preserves the old label and backfill continues', async () => {
  const f = fixture();
  f.context.eventName = 'workflow_dispatch';
  f.hooks.add = async ({ issue_number }) => {
    if (issue_number === 1) throw Object.assign(new Error('API unavailable'), { status: 502 });
    assert.ok(f.labels.has('size/L'));
  };
  await run(f);
  assert.match(f.warnings[0], /#1.*API unavailable/);
  assert.ok(f.calls.some(([name, number]) => name === 'add' && number === 2));
});

test('head or base changes with the same file count retry before mutating labels', async () => {
  for (const field of ['sha', 'baseSha']) {
    const f = fixture();
    let pages = 0;
    f.hooks.files = () => {
      if (++pages === 1) f.state[field] = 'new';
      return [{ filename: 'example.js', additions: pages === 1 ? 10 : 500, deletions: 0 }];
    };
    await run(f);
    assert.deepEqual(f.calls.filter(([name]) => name === 'add'), [['add', 1, 'size/XL']]);
    assert.deepEqual([...f.labels], ['bug', 'size/XL']);
  }
});

test('a stale writer finishing after a newer run reconciles to exactly one current size', async () => {
  const f = fixture();
  let release, entered;
  const blocked = new Promise((resolve) => { release = resolve; });
  const waiting = new Promise((resolve) => { entered = resolve; });
  f.hooks.add = async ({ labels }) => {
    if (labels.includes('size/S')) { entered(); await blocked; }
  };
  const older = run(f);
  await waiting;
  f.state.sha = 'new';
  f.state.additions = 500;
  await run(f);
  release();
  await older;
  assert.deepEqual([...f.labels], ['bug', 'size/XL']);
  assert.deepEqual(f.warnings, []);
});

test('retries are bounded when the PR keeps changing', async () => {
  const f = fixture();
  let pages = 0;
  f.hooks.files = () => {
    f.state.sha = `revision-${++pages}`;
    return [{ filename: 'example.js', additions: 10, deletions: 0 }];
  };
  await run(f);
  assert.equal(pages, 3);
  assert.match(f.warnings[0], /changed repeatedly/);
});

test('manual single-PR input is validated before any API calls', async () => {
  const previous = process.env.PR_NUMBER;
  try {
    for (const input of ['0', '-1', 'example', '9007199254740992', '2']) {
      const f = fixture();
      f.context.eventName = 'workflow_dispatch';
      process.env.PR_NUMBER = input;
      await run(f);
      if (input === '2') {
        assert.ok(f.calls.some(([name, number]) => name === 'get' && number === 2));
        assert.equal(f.calls.some(([name, endpoint]) => name === 'paginate' && endpoint === 'prs'), false);
      } else {
        assert.equal(f.calls.length, 0);
        assert.equal(f.warnings.length, 1);
      }
    }
  } finally {
    if (previous === undefined) delete process.env.PR_NUMBER;
    else process.env.PR_NUMBER = previous;
  }
});

test('only already_exists validation failures are treated as concurrent creation', async () => {
  for (const code of ['already_exists', 'invalid']) {
    const f = fixture();
    f.github.rest.issues.getLabel = async () => { throw Object.assign(new Error('missing'), { status: 404 }); };
    f.github.rest.issues.createLabel = async () => {
      throw Object.assign(new Error('validation failed'), {
        status: 422, response: { data: { errors: [{ code }] } },
      });
    };
    await run(f);
    assert.equal(f.labels.has('size/S'), code === 'already_exists');
    assert.equal(f.warnings.length, code === 'already_exists' ? 0 : 1);
  }
});

// Exercise both discovery and individual-PR handling: neither may hide bugs or
// mistake a recognized transport failure for a programming error.
test('HTTP and network failures are logged at both API boundaries', async () => {
  const errors = [
    Object.assign(new Error('service unavailable'), { status: 502 }),
    Object.assign(new Error('DNS unavailable'), { code: 'EAI_AGAIN' }),
    Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connection lost'), { code: 'ECONNRESET' }),
    }),
    Object.assign(new Error('request aborted'), { name: 'AbortError' }),
  ];
  for (const error of errors) {
    for (const discovery of [true, false]) {
      const f = fixture();
      f.context.eventName = 'workflow_dispatch';
      if (discovery) f.github.paginate = async () => { throw error; };
      else f.hooks.add = async ({ issue_number }) => { if (issue_number === 1) throw error; };
      await assert.doesNotReject(run(f));
      assert.equal(f.warnings.length, 1);
      assert.ok(f.warnings[0].includes(error.message));
      if (!discovery) assert.ok(f.calls.some(([name, number]) => name === 'add' && number === 2));
    }
  }
});

test('unexpected programming errors propagate from discovery and individual PRs', async () => {
  for (const error of [new TypeError('invalid shape'), new Error('unexpected state'),
    Object.assign(new Error('bad argument'), { code: 'ERR_INVALID_ARG_TYPE' })]) {
    for (const discovery of [true, false]) {
      const f = fixture();
      f.context.eventName = 'workflow_dispatch';
      if (discovery) f.github.paginate = async () => { throw error; };
      else f.hooks.files = () => { throw error; };
      await assert.rejects(run(f), (actual) => actual === error);
      assert.deepEqual(f.warnings, []);
      assert.deepEqual([...f.labels], ['bug', 'size/L']);
    }
  }
});
