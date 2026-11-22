'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pluginRoot, projectRoot, reviewFolder, requireLocalPath } = require('./workspace.cjs');

function createReview(folder) {
  fs.mkdirSync(folder, { recursive: true });
  const page = path.join(folder, 'review.html');
  fs.copyFileSync(path.join(pluginRoot, 'review.html'), page, fs.constants.COPYFILE_EXCL);
  console.log(page);
}

function checkReview(folder) {
  const data = requireLocalPath(folder, path.join(folder, 'review-data.js'));
  requireLocalPath(folder, path.join(folder, 'review.html'));
  const result = spawnSync(process.execPath, [path.join(pluginRoot, 'check_review.js'), data, '--verify-page'], {
    stdio: 'inherit', windowsHide: true,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function readReview(folder) {
  const file = requireLocalPath(folder, path.join(folder, 'review-data.js'));
  const source = fs.readFileSync(file, 'utf8');
  const match = /^\s*window\.REVIEW_DATA\s*=\s*(\{[\s\S]*\})\s*;?\s*$/.exec(source);
  if (!match) throw new Error('review-data.js must contain one window.REVIEW_DATA assignment with strict JSON.');
  return JSON.parse(match[1]);
}

// Match the decision fingerprint in review.html so edits to a proposal invalidate old approvals.
function fingerprint(proposed, original, options) {
  const text = JSON.stringify([proposed, original, options]);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return (hash >>> 0).toString(16);
}

function approvedText(item, decision) {
  const options = item.options ?? [];
  const recommended = options.find(option => option.recommended) ?? options[0];
  const proposed = item.proposed || recommended?.text || '';
  const original = item.original || null;
  if (fingerprint(proposed, original, options.map(option => option.text)) !== decision.fp) {
    throw new Error(`The proposal for ${item.id} changed since decisions were saved. Save fresh decisions.`);
  }
  const choice = decision.option == null ? recommended : options.find(option => option.id === decision.option);
  if (decision.option != null && !choice) throw new Error(`Unknown option for ${item.id}: ${decision.option}`);
  const text = decision.revised_override ?? choice?.text ?? proposed;
  if (typeof text !== 'string') throw new Error(`The accepted proposal for ${item.id} must be text.`);
  return text;
}

function gitApply(root, patch, args) {
  const config = fs.existsSync(path.join(root, '.git')) ? [] : ['-c', 'core.autocrlf=false'];
  const result = spawnSync('git', [...config, 'apply', '--binary', '--recount', '--whitespace=nowarn', ...args, '-'], {
    cwd: root, input: patch, encoding: 'utf8', windowsHide: true, maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || 'git apply failed.');
  return result.stdout;
}

function loadApproved(folder, id) {
  const review = readReview(folder);
  const files = fs.readdirSync(folder).filter(name => name.startsWith(`${id}.decisions.`)
    && /^\d{8}-\d{6}\.json$/.test(name.slice(`${id}.decisions.`.length))).sort();
  const latest = files.at(-1);
  if (!latest) throw new Error(`Use Save decisions in ${path.join(folder, 'review.html')} first.`);
  const batch = readJson(requireLocalPath(folder, path.join(folder, latest)));
  if (review.review_id !== id || batch.review_id !== id || batch.schema !== 'agent-review-decisions/1'
      || !Array.isArray(review.items) || !Array.isArray(batch.decisions)) {
    throw new Error('The decisions file and review data must match this review ID.');
  }

  const items = new Map(review.items.map(item => [item.id, item]));
  const seen = new Set();
  const accepted = [];
  for (const decision of batch.decisions) {
    const item = items.get(decision.id);
    if (!item || seen.has(decision.id)) throw new Error(`Unknown or duplicate decision: ${decision.id}`);
    seen.add(decision.id);
    if (decision.status === 'accepted') {
      accepted.push({ id: item.id, lang: item.lang, text: approvedText(item, decision) });
    }
  }
  return { latest, accepted };
}

function applyReview(root, folder, id) {
  const { latest, accepted } = loadApproved(folder, id);
  const manual = [];
  const pending = [];
  let existing = 0;
  for (const item of accepted) {
    if (item.lang !== 'diff') {
      manual.push(item);
      continue;
    }
    if (!item.text.startsWith('diff --git ')) {
      throw new Error(`The accepted edit for ${item.id} must be a Git diff. Restore or correct it in the review page.`);
    }
    const patch = item.text.endsWith('\n') ? item.text : `${item.text}\n`;
    const stats = gitApply(root, patch, ['--numstat', '-z']);
    for (const record of stats.split('\0').filter(Boolean)) {
      const name = record.replace(/^(?:\d+|-)\t(?:\d+|-)\t/, '');
      if (name.split(/[\\/]/).some(part => !part || /^\.git$/i.test(part) || part === '.' || part === '..')) {
        throw new Error(`Unsupported patch path: ${name}`);
      }
      requireLocalPath(root, path.resolve(root, name));
    }
    try {
      gitApply(root, patch, ['--check']);
      pending.push(patch);
    } catch (forwardError) {
      try {
        gitApply(root, patch, ['--reverse', '--check']);
      } catch {
        throw forwardError;
      }
      existing++;
    }
  }
  if (pending.length) {
    const patch = pending.join('');
    gitApply(root, patch, ['--check']);
    gitApply(root, patch, []);
  }
  console.log(`Applied ${pending.length} accepted patch item(s) from ${latest}.`);
  if (existing) console.log(`${existing} accepted patch item(s) were already present.`);
  if (manual.length) console.log('Accepted items for manual execution: ' + JSON.stringify(manual));
}

if (require.main === module) {
  try {
    const [action, id, ...extra] = process.argv.slice(2);
    if (!id || extra.length || !['new', 'check', 'apply'].includes(action)) {
      throw new Error('Usage: node review.cjs <new|check|apply> <review-id>');
    }
    const root = projectRoot(process.cwd());
    const folder = reviewFolder(root, id);
    if (action === 'new') createReview(folder);
    else if (action === 'check') process.exitCode = checkReview(folder);
    else applyReview(root, folder, id);
  } catch (error) {
    console.error(`Agent Review Desk: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { loadApproved };
