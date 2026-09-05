'use strict';
function text(v, n) { return String(v == null ? '' : v).trim().slice(0, n); }
function slug(v) { return text(v, 120).toLowerCase().replace(/[^a-z0-9._:-]+/g, '-').replace(/^-+|-+$/g, ''); }
function inside(path, root, candidate) { const rel = path.relative(root, candidate); return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)); }
function admitLocalProductArtifact(deps, input) {
  const d = deps || {}, row = input && typeof input === 'object' ? input : {}, artifactId = slug(row.artifactId), projectId = slug(row.projectId), sourcePath = text(row.sourcePath, 1000), expectedSha256 = text(row.sha256, 64).toLowerCase();
  if (!d.fs || !d.path || !d.crypto || !d.deliverables || !d.workspaces) throw new Error('local artifact admission dependencies unavailable');
  if (!artifactId || !projectId || !sourcePath || !/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error('local artifact admission requires stable IDs, source path, and SHA-256');
  if (!d.projectExists(projectId)) throw new Error('product project not found');
  const source = d.path.resolve(sourcePath), roots = (Array.isArray(d.allowedRoots) ? d.allowedRoots : []).map(root => d.path.resolve(root));
  if (!roots.length || !roots.some(root => inside(d.path, root, source))) throw new Error('source path is outside configured product import roots');
  const stat = d.fs.statSync(source); if (!stat.isFile()) throw new Error('local artifact source must be a file');
  const realSource = d.fs.realpathSync(source), realRoots = roots.map(root => { try { return d.fs.realpathSync(root); } catch (_) { return ''; } }).filter(Boolean);
  if (!realRoots.some(root => inside(d.path, root, realSource))) throw new Error('source path is outside configured product import roots');
  const sourceBytes = d.fs.readFileSync(source), actual = d.crypto.createHash('sha256').update(sourceBytes).digest('hex');
  if (actual !== expectedSha256) throw new Error('local artifact SHA-256 mismatch');
  const destinationDir = d.path.join(d.workspaces, 'product-artifacts', encodeURIComponent(projectId), encodeURIComponent(artifactId)), destination = d.path.join(destinationDir, d.path.basename(source));
  const prior = d.deliverables.list().find(item => item && item.id === artifactId);
  if (prior) {
    const same = prior.status === 'verified' && prior.source === 'verified-local-import' && prior.files.some(file => d.path.resolve(file.path) === d.path.resolve(destination)) && String(prior.summary || '').includes(actual);
    if (!same) throw new Error('local artifact identity conflict');
    return Promise.resolve({ schema: 'pine-star.local-product-artifact.v1', artifact: prior, sha256: actual, sourcePath: source, canonicalPath: destination, idempotent: true, externalAction: false, spendingAuthorityUsd: 0 });
  }
  d.fs.mkdirSync(destinationDir, { recursive: true });
  if (d.fs.existsSync(destination)) { const existing = d.crypto.createHash('sha256').update(d.fs.readFileSync(destination)).digest('hex'); if (existing !== expectedSha256) throw new Error('local artifact destination conflict'); }
  else d.fs.writeFileSync(destination, sourceBytes, { flag: 'wx' });
  const canonical = d.fs.readFileSync(destination), canonicalHash = d.crypto.createHash('sha256').update(canonical).digest('hex');
  if (canonicalHash !== actual) throw new Error('local artifact canonical copy verification failed');
  return d.deliverables.record({ id: artifactId, agentId: 'station', runId: '', title: text(row.title, 200) || d.path.basename(source), source: 'verified-local-import', status: 'verified', kind: 'file', summary: 'Verified SHA-256 ' + actual + '; authenticated local import from ' + source + '; copied into canonical Pine Star storage.', files: [{ path: destination, bytes: canonical.length }] }, typeof d.now === 'function' ? d.now() : Date.now()).then(record => ({ schema: 'pine-star.local-product-artifact.v1', artifact: record, sha256: actual, sourcePath: source, canonicalPath: destination, idempotent: false, externalAction: false, spendingAuthorityUsd: 0 }));
}
module.exports = { admitLocalProductArtifact, inside };
