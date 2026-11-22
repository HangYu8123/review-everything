'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { isReviewArtifact, pluginRoot, projectRoot, reviewFolder, reviewId } = require('../scripts/workspace.cjs');
const { loadApproved } = require('../scripts/review.cjs');

const skill = path.join(pluginRoot, 'skills', 'review-first', 'SKILL.md');
const runner = path.join(pluginRoot, 'scripts', 'review.cjs');
const policy = `Agent Review Desk is active. Read ${JSON.stringify(skill)} before handling a change request. ` +
  'Inspect the workspace, then propose changes in wait-for-review/<review-id>/review.html before changing sources, settings, or external state. ' +
  `Use node ${JSON.stringify(runner.replaceAll('\\', '/'))} new <review-id> to start the page. ` +
  'Write the proposal and preview artifacts inside its review folder. Ask the user to save decisions in the page. ' +
  'For approved patches use the review apply workflow. Read-only questions can be answered directly.';

const readTools = new Set([
  'Read', 'Glob', 'Grep', 'LS', 'LSP', 'Skill', 'ToolSearch', 'WebSearch', 'WebFetch',
  'AskUserQuestion', 'TodoWrite', 'update_plan', 'request_user_input', 'view_image',
  'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource',
  'ReadMcpResourceTool', 'ListMcpResourcesTool', 'ListMcpResourceTemplatesTool',
]);
const readCommands = new Set([
  'cat', 'ls', 'pwd', 'head', 'tail', 'wc', 'stat', 'file', 'which', 'where.exe',
  'get-location', 'get-childitem', 'get-content', 'get-item', 'test-path', 'resolve-path', 'select-string',
]);
const gitReads = new Set(['status', 'diff', 'log', 'show', 'ls-files', 'ls-tree', 'rev-parse', 'grep', 'blame']);

function turnMode(prompt) {
  const text = String(prompt ?? '').trim();
  const apply = /^apply (?:review|(?:the )?(?:saved )?decisions for) ([a-z0-9][a-z0-9-]{0,79})(?=\s|[.!?](?:\s|$)|$)/i.exec(text);
  if (apply) return { apply: apply[1].toLowerCase() };
  const direct = /^(?:please )?just do it(?:[.,:!](?:\s|$)|$)/i.test(text)
    || /(?:[.,!]\s+|\r?\n\s*)(?:please )?just do it[.!]?$/i.test(text);
  return { direct };
}

function statePath(session) {
  const data = process.env.PLUGIN_DATA || process.env.CLAUDE_PLUGIN_DATA;
  if (!data || !session) throw new Error('The host did not provide plugin data and session identifiers.');
  const key = createHash('sha256').update(session).digest('hex');
  return path.join(data, 'review-turns', `${key}.json`);
}

function saveTurn(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
  try {
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

function loadTurn(file, turnId) {
  if (!fs.existsSync(file)) return {};
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  return state.turnId === turnId ? state : {};
}

// Admit simple arguments only. Shell operators, expansions, and multiline scripts go through review.
function commandArgs(command) {
  if (typeof command !== 'string' || /[\r\n`$%]/.test(command)) return [];
  const input = command.trim();
  const token = /\s*(?:"([^"\\]*(?:\\(?!["\\])[^"\\]*)*)"|'([^']*)'|([^\s"'<>;&|(){}*?\[\]]+))(?=\s|$)/gy;
  const args = [];
  while (token.lastIndex < input.length) {
    const match = token.exec(input);
    if (!match) return [];
    args.push(match[1] ?? match[2] ?? match[3]);
  }
  return args;
}

function allowShell(command, state) {
  const [exe, ...args] = commandArgs(command);
  const name = exe?.toLowerCase();
  if (readCommands.has(name)) return true;
  if (name === 'rg') return args.every(arg => !/^--(?:pr|host)/i.test(arg));
  if (name === 'git' && gitReads.has(args[0])) {
    return args.slice(1).every(arg => !/^--(?:out|ext-diff|textconv|filters|open-files-in-pager|exec|paginate)/i.test(arg));
  }
  if (name !== 'node' && name !== 'node.exe') return false;
  const [script, action, id, ...extra] = args;
  if (!script || !path.isAbsolute(script) || path.relative(runner, script) !== '') return false;
  if (!reviewId.test(id ?? '') || extra.length) return false;
  return action === 'new' || action === 'check' || (action === 'apply' && state.apply === id);
}

function patchTargets(command) {
  if (typeof command !== 'string' || !command.startsWith('*** Begin Patch')) return [];
  const names = [];
  for (const line of command.split(/\r?\n/)) {
    const match = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/.exec(line);
    if (match) names.push(match[1]);
  }
  return names;
}

function allowTool(event, state) {
  const name = event.tool_name;
  const input = event.tool_input ?? {};
  if (state.direct === true || state.manual === true) return true;
  if (readTools.has(name)) return true;
  if (name === 'Bash' || name === 'PowerShell' || name === 'exec_command' || name === 'shell_command') {
    return allowShell(input.command, state);
  }
  let targets = [];
  if (name === 'apply_patch') targets = patchTargets(input.command);
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(name)) {
    targets = [input.file_path ?? input.notebook_path];
  }
  if (!targets.length) return false;
  const cwd = fs.realpathSync(event.cwd);
  const root = state.root ?? projectRoot(cwd);
  return targets.every(target => isReviewArtifact(root, cwd, target));
}

function reply(event, output) {
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: event, ...output } }));
}

function run(event) {
  const kind = event.hook_event_name;
  const file = statePath(event.session_id);
  if (kind === 'SessionStart') {
    fs.rmSync(file, { force: true });
    return reply(kind, { additionalContext: policy });
  }
  if (kind === 'UserPromptSubmit') {
    const root = projectRoot(process.env.CLAUDE_PROJECT_DIR || event.cwd);
    const state = { ...turnMode(event.prompt), root, turnId: event.turn_id };
    if (state.apply) {
      try {
        const { accepted } = loadApproved(reviewFolder(root, state.apply), state.apply);
        state.manual = accepted.some(item => item.lang !== 'diff');
      } catch {
        // Leave other tools gated. The apply command reports why the decisions could not be used.
      }
    }
    saveTurn(file, state);
    const message = state.direct ? 'The user explicitly requested direct execution for this turn. Follow normal host permissions.'
      : state.apply ? `Use the bundled apply command for review ${state.apply}. Execute only the accepted patches and any manual items the command reports. ${policy}` : policy;
    return reply(kind, { additionalContext: message });
  }
  if (kind === 'PreToolUse' && !allowTool(event, loadTurn(file, event.turn_id))) {
    return reply(kind, { permissionDecision: 'deny', permissionDecisionReason: policy });
  }
}

try {
  run(JSON.parse(fs.readFileSync(0, 'utf8').replace(/^\uFEFF/, '')));
} catch (error) {
  console.error(`Agent Review Desk: ${error.message}`);
  process.exitCode = 2;
}
