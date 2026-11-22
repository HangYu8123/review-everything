#!/usr/bin/env node
// Checks a review-data.js against the spec at the top of review.html.
// Usage: node check_review.js path/to/review-data.js [--verify-page]
// Exit code 1 on errors. Warnings point at what makes a review harder to decide on.
'use strict';
const fs = require('fs');
const path = require('path');

const file = process.argv[2] || 'review-data.js';
const errors = [];
const warnings = [];
const err = (m) => errors.push(m);
const warn = (m) => warnings.push(m);

const PRIORITY_NAMES = [
  ['0', 'p0', 'critical', 'blocker', 'urgent'],
  ['1', 'p1', 'high', 'major', 'important'],
  ['2', 'p2', 'medium', 'moderate', 'normal'],
  ['3', 'p3', 'low', 'minor', 'nit', 'trivial'],
];
const KINDS = ['change', 'finding', 'decision', 'question', 'plan', 'test', 'claim'];
const EV_KINDS = ['file', 'code', 'test', 'log', 'quote', 'metric', 'url', 'link', 'image', 'data', 'command', 'doc', 'note'];
const PAPER_GROUPS = ['summary', 'strength', 'weakness', 'improvement', 'recommendation'];
const inUnit = (v) => v == null || (typeof v === 'number' && v >= 0 && v <= 100);
const list = (value) => Array.isArray(value) ? value : [];
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function readReview(path) {
  let text;
  try {
    text = fs.readFileSync(path, 'utf8');
  } catch (e) {
    console.error('Cannot read ' + path + ': ' + e.message);
    process.exit(1);
  }
  let data;
  try {
    data = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  } catch (e) {
    console.error('The part from the first { to the last } is not strict JSON: ' + e.message);
    process.exit(1);
  }
  if (!/window\.REVIEW_DATA\s*=/.test(text)) err('The file must set window.REVIEW_DATA.');
  return data;
}

const data = readReview(file);
if (process.argv[3] === '--verify-page') {
  const page = path.join(path.dirname(file), 'review.html');
  try {
    const template = fs.readFileSync(path.join(__dirname, 'review.html'));
    if (!fs.readFileSync(page).equals(template)) {
      err(page + ' differs from the current review template. Copy review.html unchanged and link any prototype from review-data.js.');
    }
  } catch (e) {
    err('Could not verify ' + page + ': ' + e.message);
  }
}
if (!data.review_id) err('review_id is missing.');
else if (!/^[A-Za-z0-9_.-]+$/.test(data.review_id)) err('review_id "' + data.review_id + '" should use only letters, digits, dots, hyphens and underscores.');
if (!data.title) warn('title is missing.');
if (!data.task) warn('task is missing: record the request word for word, so the reviewer can judge the items against it.');
if (!Array.isArray(data.items) || !data.items.length) err('items is missing or empty.');
if (data.layout != null && !['rank', 'sections'].includes(data.layout)) err('layout must be "rank" or "sections".');
if (data.confidence_levels != null && (!Array.isArray(data.confidence_levels) || data.confidence_levels.length < 2)) err('confidence_levels must be a list of at least two labels, lowest first.');
list(data.categories).forEach((c, i) => {
  if (!c || (typeof c === 'object' && !c.label && !c.id)) err('Category #' + (i + 1) + ' needs a label.');
});

const items = list(data.items);
const ids = new Set();
const prioCount = [0, 0, 0, 0];
let withAgainst = 0;
function checkItem(it, i) {
  const at = 'Item ' + (it && it.id ? '"' + it.id + '"' : '#' + (i + 1));
  if (!isRecord(it)) { err(at + ' is not an object.'); return; }
  if (it.id == null) err(at + ' has no id.');
  else if (ids.has(String(it.id))) err(at + ': the id is used twice.');
  else ids.add(String(it.id));
  const paper = PAPER_GROUPS.includes(it.group);
  if (it.group != null && !paper && !it.type) warn(at + ': group "' + it.group + '" is not a paper-review section (' + PAPER_GROUPS.join(', ') + ').');
  if (!it.title && !paper) warn(at + ' has no title. The page falls back to the first sentence of proposed.');
  else if (String(it.title).length > 90) warn(at + ': the title is ' + String(it.title).length + ' characters. Keep it under about 80.');
  if (it.kind && !KINDS.includes(it.kind)) warn(at + ': kind "' + it.kind + '" is not one of ' + KINDS.join(', ') + '.');
  const name = String(it.priority).toLowerCase();
  const priority = PRIORITY_NAMES.findIndex((names) => names.includes(name));
  if (it.priority == null) warn(at + ' has no priority. It is ranked as P2.');
  else if (priority < 0) err(at + ': priority "' + it.priority + '" is not 0-3, P0-P3, or critical/high/medium/low.');
  else prioCount[priority]++;
  ['impact', 'confidence', 'risk'].forEach((k) => { if (!inUnit(it[k])) err(at + ': ' + k + ' should be a number from 0 to 1.'); });
  if (it.confidence == null) warn(at + ' has no confidence. Bulk rules on confidence will skip it.');
  checkOptions(it, at);
  const evidence = list(it.evidence);
  checkEvidence(evidence, at);
  if (evidence.some((e) => e && /against/i.test(String(e.stance || '')))) withAgainst++;
  const lightEvidence = paper && it.group !== 'weakness';
  if (!lightEvidence && (priority === 0 || priority === 1) && evidence.length < 2) warn(at + ' is P0 or P1 with fewer than two pieces of evidence.');
  ['metrics', 'checks'].forEach((k) => {
    if (it[k] != null) warn(at + ': ' + k + ' is no longer shown. Put measurements in evidence, and ask nothing beyond the item\'s own decision.');
  });
}

function checkOptions(it, at) {
  const body = it.proposed != null ? it.proposed : it.revised != null ? it.revised : it.text;
  const opts = list(it.options);
  if (!body && !opts.length && it.original == null && it.kind !== 'finding' && it.kind !== 'question') warn(at + ' has nothing to accept: no proposed or revised text and no options.');
  if (opts.length === 1) warn(at + ' has one option. Use proposed instead; options are for real choices.');
  const optIds = new Set();
  opts.forEach((o, j) => {
    const oid = String(o && o.id != null ? o.id : String.fromCharCode(65 + j));
    if (optIds.has(oid)) err(at + ': option id ' + oid + ' is used twice.');
    optIds.add(oid);
    if (!o || o.text == null) warn(at + ': option ' + oid + ' has no text.');
  });
  if (opts.filter((o) => o && o.recommended).length > 1) warn(at + ' recommends more than one option.');
}

function checkEvidence(ev, at) {
  if (!ev.length) warn(at + ' has no evidence. Put the evidence on the item it supports.');
  const evIds = new Set();
  ev.forEach((e, j) => {
    const eat = at + ' evidence ' + (e && e.id ? '"' + e.id + '"' : '#' + (j + 1));
    if (!isRecord(e)) { err(eat + ' is not an object.'); return; }
    if (e.id != null) {
      const id = String(e.id);
      if (evIds.has(id)) err(eat + ': the id is used twice in this item.');
      evIds.add(id);
    }
    if (e.kind && !EV_KINDS.includes(e.kind)) warn(eat + ': kind "' + e.kind + '" is not one of ' + EV_KINDS.join(', ') + '.');
    if (!e.where && !e.url) warn(eat + ' has no where: give a location the reviewer can check.');
    if (!e.text && e.value == null && !e.image && !e.url) warn(eat + ' has no text, value, image or url.');
    if (e.url && !/^https?:\/\//i.test(e.url)) warn(eat + ': url should start with http:// or https://.');
  });
}

function checkMachine(machine) {
  if (!machine) {
    warn('No machine. A state machine of the run helps the reviewer see where each item came from.');
    return;
  }
  const states = list(machine.states);
  const linked = new Set();
  const sids = new Set();
  states.forEach((s, i) => {
    if (!s || s.id == null) { err('Machine state #' + (i + 1) + ' has no id.'); return; }
    if (sids.has(String(s.id))) err('Machine state "' + s.id + '" is used twice.');
    sids.add(String(s.id));
    if (s.label && String(s.label).length > 28) warn('Machine state "' + s.id + '": label is longer than 28 characters and will be cut.');
    const refs = s.items || s.points || [];
    if (!Array.isArray(refs)) {
      err('Machine state "' + s.id + '" needs a list of item ids.');
      return;
    }
    refs.forEach((id) => {
      if (!ids.has(String(id))) err('Machine state "' + s.id + '" links the unknown item "' + id + '".');
      linked.add(String(id));
    });
  });
  if (states.length > 16) warn('The machine has ' + states.length + ' states. Aim for 6 to 14.');
  list(machine.transitions).forEach((t, i) => {
    if (!isRecord(t)) { err('Machine transition #' + (i + 1) + ' is not an object.'); return; }
    if (!sids.has(String(t.from))) err('A transition starts at the unknown state "' + t.from + '".');
    if (!sids.has(String(t.to))) err('A transition ends at the unknown state "' + t.to + '".');
  });
  const reviewItems = items.filter((it) => isRecord(it) && it.id != null);
  reviewItems.forEach((it) => {
    [].concat(it.state == null ? [] : it.state, it.states || []).forEach((sid) => {
      if (!sids.has(String(sid))) err('Item "' + it.id + '" names the unknown state "' + sid + '".');
      linked.add(String(it.id));
    });
  });
  const loose = reviewItems.filter((it) => !linked.has(String(it.id))).map((it) => it.id);
  if (loose.length) warn('Not linked to any machine state: ' + loose.join(', ') + '.');
}

items.forEach(checkItem);
checkMachine(data.machine);

console.log(file + ': ' + items.length + ' items · P0 ' + prioCount[0] + ' · P1 ' + prioCount[1] + ' · P2 ' + prioCount[2] + ' · P3 ' + prioCount[3] +
  ' · ' + withAgainst + ' with evidence against' + (data.machine ? ' · ' + list(data.machine.states).length + ' machine states' : ''));
if (items.length && !withAgainst) warn('No item has evidence against it. If there is any, include it with stance "against".');
errors.forEach((e) => console.log('  ERROR  ' + e));
warnings.forEach((w) => console.log('  warn   ' + w));
if (!errors.length) console.log(warnings.length ? 'OK, with ' + warnings.length + ' warning' + (warnings.length === 1 ? '' : 's') + '.' : 'OK.');
process.exit(errors.length ? 1 : 0);
