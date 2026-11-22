'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const pluginRoot = path.resolve(__dirname, '..');
const reviewId = /^[a-z0-9][a-z0-9-]{0,79}$/;

function projectRoot(cwd) {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd, encoding: 'utf8', windowsHide: true, timeout: 3000,
  });
  const root = result.status === 0 ? result.stdout.trimEnd() : cwd;
  return fs.realpathSync(root);
}

function inside(parent, target) {
  const relative = path.relative(parent, target);
  return !!relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function requireLocalPath(root, target) {
  if (!inside(root, target)) throw new Error(`Path is outside ${root}: ${target}`);
  for (let current = target; inside(root, current); current = path.dirname(current)) {
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink() || (stat?.isFile() && stat.nlink > 1)) {
      throw new Error(`Linked paths are unsupported: ${current}`);
    }
  }
  return target;
}

function reviewFolder(root, id) {
  if (!reviewId.test(id)) throw new Error('Use a review ID of lowercase letters, digits, and hyphens.');
  return requireLocalPath(root, path.join(root, 'wait-for-review', id));
}

function isReviewArtifact(root, cwd, name) {
  if (typeof name !== 'string' || /:(?![\\/])|^[\\/]{2}/.test(name)) return false;
  const target = path.resolve(cwd, name);
  const queue = path.join(root, 'wait-for-review');
  if (!inside(queue, target)) return false;
  const parts = path.relative(queue, target).split(path.sep);
  if (parts.length < 2 || !reviewId.test(parts[0])) return false;
  if (parts.slice(1).some(part => part.toLowerCase() === '.git' || /[ .]$/.test(part))) return false;
  if (/\.decisions\..*\.json$/i.test(parts.at(-1))) return false;
  requireLocalPath(root, target);
  return true;
}

module.exports = { pluginRoot, projectRoot, reviewFolder, reviewId, isReviewArtifact, requireLocalPath };
