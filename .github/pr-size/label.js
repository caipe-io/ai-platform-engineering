// Labels pull requests with one size/* bucket based on changed lines.
// Runs from the base branch under pull_request_target: it reads pull request
// metadata through the API only and never checks out or runs pull request code.

const config = require('./config.json');

// The API cannot provide a complete generated-file-aware count past this limit.
const LIST_FILES_LIMIT = 3000;
const NETWORK_ERROR_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
]);

function isOperationalError(error) {
  return (Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599) ||
    NETWORK_ERROR_CODES.has(error?.code) || NETWORK_ERROR_CODES.has(error?.cause?.code) ||
    error?.name === 'AbortError' || error?.name === 'TimeoutError';
}

function globToRegExp(glob) {
  let pattern = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        pattern += '(?:.*/)?';
        i += 2;
      } else {
        pattern += '.*';
        i += 1;
      }
    } else if (char === '*') {
      pattern += '[^/]*';
    } else if (char === '?') {
      pattern += '[^/]';
    } else {
      pattern += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${pattern}$`);
}

function isGenerated(path, globs = config.generated) {
  return globs.some((glob) => globToRegExp(glob).test(path));
}

function bucketFor(lines, buckets = config.buckets) {
  let match = buckets[0];
  for (const bucket of buckets) {
    if (lines >= bucket.min) {
      match = bucket;
    }
  }
  return match;
}

function countChangedLines(files, globs = config.generated) {
  return files
    .filter((file) => !isGenerated(file.filename, globs) ||
      (file.previous_filename && !isGenerated(file.previous_filename, globs)))
    .reduce((total, file) => total + file.additions + file.deletions, 0);
}

async function ensureLabel(github, repo, bucket, core) {
  try {
    const { data } = await github.rest.issues.getLabel({ ...repo, name: bucket.name });
    if (data.color !== bucket.color || data.description !== bucket.description) {
      await github.rest.issues.updateLabel({
        ...repo,
        name: bucket.name,
        color: bucket.color,
        description: bucket.description,
      });
      core.info(`Updated label ${bucket.name}`);
    }
  } catch (error) {
    if (error.status !== 404) {
      throw error;
    }
    try {
      await github.rest.issues.createLabel({
        ...repo,
        name: bucket.name,
        color: bucket.color,
        description: bucket.description,
      });
      core.info(`Created label ${bucket.name}`);
    } catch (createError) {
      // Only already_exists means another run created the label.
      if (createError.status !== 422 || !createError.response?.data?.errors?.some(
        (item) => item.code === 'already_exists',
      )) {
        throw createError;
      }
    }
  }
}

async function labelPullRequest({ github, repo, core, pullNumber }) {
  const params = { ...repo, pull_number: pullNumber };
  const issue = { ...repo, issue_number: pullNumber };
  // Backfills can overlap automatic runs. Recheck the revision and labels after
  // every update so a stale writer reconciles again instead of leaving duplicates.
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data: pr } = await github.rest.pulls.get(params);
    if (pr.state !== 'open') return;
    if (pr.changed_files > LIST_FILES_LIMIT) {
      core.warning(`#${pullNumber}: exceeds the 3000-file API limit; leaving labels unchanged`);
      return;
    }
    const files = await github.paginate(github.rest.pulls.listFiles, {
      ...params, per_page: 100,
    });
    if (files.length !== pr.changed_files) {
      core.warning(`#${pullNumber}: incomplete file list; leaving labels unchanged`);
      return;
    }
    const lines = countChangedLines(files);
    const bucket = bucketFor(lines);
    await ensureLabel(github, repo, bucket, core);
    const sameRevision = (other) => other.state === 'open' &&
      other.head.sha === pr.head.sha && other.base.sha === pr.base.sha &&
      other.changed_files === pr.changed_files;
    const { data: latest } = await github.rest.pulls.get(params);
    if (!sameRevision(latest)) continue;
    const current = (await github.paginate(github.rest.issues.listLabelsOnIssue, {
      ...issue, per_page: 100,
    })).map((label) => label.name);
    // Keep the previous size if adding the replacement fails.
    if (!current.includes(bucket.name)) {
      await github.rest.issues.addLabels({ ...issue, labels: [bucket.name] });
    }
    for (const name of current) {
      if (name.startsWith(config.labelPrefix) && name !== bucket.name) {
        try {
          await github.rest.issues.removeLabel({ ...issue, name });
        } catch (error) {
          if (error.status !== 404) throw error;
        }
      }
    }
    const { data: after } = await github.rest.pulls.get(params);
    const sizes = (await github.paginate(github.rest.issues.listLabelsOnIssue, {
      ...issue, per_page: 100,
    })).filter((label) => label.name.startsWith(config.labelPrefix));
    if (!sameRevision(after) || sizes.length !== 1 || sizes[0].name !== bucket.name) continue;
    core.info(`#${pullNumber}: ${lines} changed lines -> ${bucket.name}`);
    return;
  }
  core.warning(`#${pullNumber}: changed repeatedly while labeling; rerun the workflow`);
}

async function run({ github, context, core }) {
  const repo = { owner: context.repo.owner, repo: context.repo.repo };
  try {
    let pullNumbers;
    if (context.eventName === 'workflow_dispatch') {
      const input = (process.env.PR_NUMBER || '').trim();
      if (input) {
        if (!/^[1-9][0-9]*$/.test(input) || !Number.isSafeInteger(Number(input))) {
          core.warning('pr_number must be a positive safe integer');
          return;
        }
        pullNumbers = [Number(input)];
      } else {
        const open = await github.paginate(github.rest.pulls.list, {
          ...repo, state: 'open', per_page: 100,
        });
        pullNumbers = open.map((pr) => pr.number);
      }
    } else {
      pullNumbers = [context.payload.pull_request.number];
    }
    for (const pullNumber of pullNumbers) {
      try {
        await labelPullRequest({ github, repo, core, pullNumber });
      } catch (error) {
        if (!isOperationalError(error)) throw error;
        core.warning(`#${pullNumber}: size labeling unavailable: ${error.message}`);
      }
    }
  } catch (error) {
    // Discovery can fail before there is an individual PR to process.
    if (!isOperationalError(error)) throw error;
    core.warning(`Size labeling unavailable: ${error.message}`);
  }
}

module.exports = { globToRegExp, isGenerated, bucketFor, countChangedLines, run };
