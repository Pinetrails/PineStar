/* Typed task postconditions.
 *
 * A model saying "done" is not completion evidence. This module evaluates only Commander/host supplied,
 * bounded predicates against facts the host can mechanically observe. It deliberately supports a small set:
 * workspace artifacts and an exact verification command. Browser and connector semantics remain judgment calls
 * until a future typed adapter can prove their domain-specific predicates.
 */
'use strict';

const MAX_REQUIREMENTS = 20;
const MAX_PATH = 260;
const MAX_TEXT = 500;
const MAX_COMMAND = 1000;
const TYPES = new Set(['artifact_exists', 'artifact_contains', 'artifact_sha256', 'verification_passed']);

function bounded(v, n) { return String(v == null ? '' : v).trim().slice(0, n); }
function samePath(a, b) {
  const norm = v => bounded(v, MAX_PATH).replace(/\\/g, '/').replace(/^\.\//, '');
  return norm(a) === norm(b);
}
function sameCommand(a, b) { return bounded(a, MAX_COMMAND).replace(/\s+/g, ' ') === bounded(b, MAX_COMMAND).replace(/\s+/g, ' '); }

function normalizeContract(raw) {
  if (raw == null) return { contract: null, errors: [] };
  const src = Array.isArray(raw) ? { requirements: raw } : raw;
  if (!src || typeof src !== 'object' || Array.isArray(src)) return { contract: null, errors: ['postconditions must be an object or array'] };
  const rows = Array.isArray(src.requirements) ? src.requirements : [];
  if (!rows.length) return { contract: null, errors: ['postconditions require at least one requirement'] };
  if (rows.length > MAX_REQUIREMENTS) return { contract: null, errors: ['postconditions exceed the 20 requirement limit'] };
  const requirements = [], errors = [], ids = new Set();
  rows.forEach((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) { errors.push('requirement ' + (index + 1) + ' must be an object'); return; }
    const type = bounded(item.type, 40);
    const id = bounded(item.id || ('pc-' + (index + 1)), 80);
    if (!TYPES.has(type)) { errors.push(id + ': unsupported type'); return; }
    if (ids.has(id)) { errors.push(id + ': duplicate id'); return; }
    ids.add(id);
    if (type.indexOf('artifact_') === 0) {
      const path = bounded(item.path, MAX_PATH);
      if (!path || path.indexOf('\0') >= 0 || path.replace(/\\/g, '/').split('/').includes('..')) { errors.push(id + ': safe relative path required'); return; }
      if (/^(?:[a-z]:[\\/]|[\\/])/i.test(path)) { errors.push(id + ': absolute paths are not allowed'); return; }
      const out = { id, type, path };
      if (type === 'artifact_contains') {
        const text = bounded(item.text, MAX_TEXT);
        if (!text) { errors.push(id + ': non-empty text required'); return; }
        out.text = text;
      }
      if (type === 'artifact_sha256') {
        const sha256 = bounded(item.sha256, 64).toLowerCase();
        if (!/^[a-f0-9]{64}$/.test(sha256)) { errors.push(id + ': 64-character sha256 required'); return; }
        out.sha256 = sha256;
      }
      requirements.push(out); return;
    }
    const command = bounded(item.command, MAX_COMMAND);
    if (!command) { errors.push(id + ': exact verification command required'); return; }
    requirements.push({ id, type, command });
  });
  if (errors.length || requirements.length !== rows.length) return { contract: null, errors };
  return {
    contract: {
      schemaVersion: 'starnet.task-postconditions.v1',
      authority: 'commander',
      requirements
    },
    errors: []
  };
}

async function assessPostconditions(input) {
  input = input || {};
  const normalized = normalizeContract(input.contract);
  const base = {
    contract: normalized.contract,
    contractErrors: normalized.errors.slice(0, 20),
    checks: []
  };
  if (!normalized.contract) {
    base.completionVerdict = input.contract == null ? 'not_assessed' : 'verification_required';
    return base;
  }
  const artifacts = Array.isArray(input.artifacts) ? input.artifacts : [];
  const evidence = Array.isArray(input.evidence) ? input.evidence : [];
  const readArtifact = typeof input.readArtifact === 'function' ? input.readArtifact : null;

  for (const req of normalized.contract.requirements) {
    let passed = false, code = 'not_proven';
    if (req.type === 'verification_passed') {
      passed = evidence.some(ev => ev && ev.kind === 'deterministic_check' && ev.strength === 'mechanical'
        && sameCommand(ev.target, req.command));
      code = passed ? 'matching_verification_passed' : 'matching_verification_missing';
    } else {
      // A pre-existing file is not proof this run completed the request. The run must have produced/touched the
      // exact artifact, then a fresh host read must prove its terminal state.
      const touched = artifacts.some(a => a && (a.kind === 'file' || a.kind === 'image') && samePath(a.path, req.path));
      if (!touched) code = 'artifact_not_produced_by_run';
      else if (!readArtifact) code = 'artifact_reader_unavailable';
      else {
        let observed = null;
        try { observed = await readArtifact(req); } catch (_) { observed = null; }
        if (!observed || !observed.exists || !observed.isFile) code = 'artifact_missing';
        else if (req.type === 'artifact_exists') { passed = true; code = 'artifact_exists'; }
        else if (req.type === 'artifact_contains') {
          passed = observed.contains === true; code = passed ? 'artifact_contains_text' : 'artifact_text_missing';
        } else {
          passed = String(observed.sha256 || '').toLowerCase() === req.sha256;
          code = passed ? 'artifact_digest_matches' : 'artifact_digest_mismatch';
        }
      }
    }
    base.checks.push({ id: req.id, type: req.type, status: passed ? 'passed' : 'failed', code });
  }

  const cleanTerminal = input.reason === 'done';
  const noUncertainMutation = !(Array.isArray(input.uncertainMutations) && input.uncertainMutations.length);
  const effectsSettled = input.effectVerdict === 'no_observed_effects' || input.effectVerdict === 'mechanically_verified';
  const allPassed = base.checks.length > 0 && base.checks.every(c => c.status === 'passed');
  if (!cleanTerminal || !allPassed) base.completionVerdict = 'incomplete';
  else if (!noUncertainMutation || !effectsSettled) base.completionVerdict = 'verification_required';
  else base.completionVerdict = 'completed_verified';
  return base;
}

module.exports = { normalizeContract, assessPostconditions, _internals: { samePath, sameCommand, TYPES, MAX_REQUIREMENTS } };
