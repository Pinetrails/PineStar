'use strict';
const FAMILIES = ['planner', 'checklist', 'tracker', 'activity-sheet', 'bundle'];
function text(v, n) { return String(v == null ? '' : v).trim().slice(0, n); }
function list(v, cap, n) { return [...new Set((Array.isArray(v) ? v : []).map(x => text(x, n)).filter(Boolean))].slice(0, cap); }
function slug(v) { return text(v, 100).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, ''); }
function normalizePineTrailPrintable(input) {
  const x = input && typeof input === 'object' ? input : {}, productId = slug(x.productId), title = text(x.title, 200), family = FAMILIES.includes(x.family) ? x.family : '';
  if (!productId || !title || !family) throw new Error('Pine Trail printable requires stable productId, title, and supported family');
  const requirements = ['Original Pine Trail-owned visual assets only', 'Print-safe margins and legible contrast', 'Editable source plus export-ready PDF', 'US Letter and A4 layouts'];
  return { productId: 'pine-trail-' + productId.replace(/^pine-trail-/, ''), title, family, description: text(x.description, 1600), targetCustomer: text(x.targetCustomer, 500), useCase: text(x.useCase, 500),
    targetMarketplaces: list(x.targetMarketplaces, 8, 100), assumptions: list(x.assumptions, 12, 240), assetRequirements: list(requirements.concat(list(x.assetRequirements, 12, 240)), 20, 240), priority: ['low', 'normal', 'high'].includes(x.priority) ? x.priority : 'normal' };
}
async function intakePineTrailPrintable(deps, input) {
  const d = deps || {}, preset = normalizePineTrailPrintable(input); if (typeof d.intakeProductIdea !== 'function') throw new Error('Pine Trail printable requires product idea intake');
  const result = await d.intakeProductIdea({ ideaId: preset.productId, title: preset.title, description: preset.description, productType: 'pine-trail-printable:' + preset.family,
    targetCustomer: preset.targetCustomer || preset.useCase, targetMarketplaces: preset.targetMarketplaces, assumptions: preset.assumptions.concat(preset.useCase ? ['Intended use: ' + preset.useCase] : []), assetRequirements: preset.assetRequirements, priority: preset.priority });
  return Object.assign({}, result, { schema: 'pine-star.pine-trail-printable-intake.v1', preset, externalAction: false, spendingAuthorityUsd: 0 });
}
function normalizePineTrailProduction(input) {
  const x = input && typeof input === 'object' ? input : {}, projectId = text(x.projectId, 100), planId = slug(x.planId), additionalQaChecks = list(x.additionalQaChecks, 8, 240), constraints = list(x.constraints, 8, 240);
  if (!projectId || !planId) throw new Error('Pine Trail production requires stable projectId and planId');
  return { projectId, planId, productSpecification: text(x.productSpecification, 1600), additionalQaChecks, constraints, priority: ['low', 'normal', 'high'].includes(x.priority) ? x.priority : 'normal' };
}
async function planPineTrailProduction(deps, input) {
  const d = deps || {}, plan = normalizePineTrailProduction(input); if (!d.projects || typeof d.createProductionPlan !== 'function') throw new Error('Pine Trail production requires project and production planner');
  const project = d.projects.get(plan.projectId); if (!project) throw new Error('product project not found');
  const prefix = 'pine-trail-printable:', family = String(project.productType || '').startsWith(prefix) ? String(project.productType).slice(prefix.length) : '';
  if (!FAMILIES.includes(family)) throw new Error('project is not a supported Pine Trail printable');
  const label = family.replace('-', ' '), deliverables = ['Editable ' + label + ' source', 'US Letter ' + label + ' PDF', 'A4 ' + label + ' PDF']; if (family === 'bundle') deliverables.push('Bundle contents manifest');
  const qaChecklist = ['Only original Pine Trail-owned visual assets', 'No clipped, overlapping, or missing content', 'Legible contrast and type at actual print size', 'Print-safe margins in US Letter and A4 exports', 'No StarNet branding or copyrighted commercial-game assets'].concat(plan.additionalQaChecks);
  const result = await d.createProductionPlan({ projectId: project.id, planId: plan.planId, productSpecification: plan.productSpecification || ('Prepare the approved Pine Trail ' + label + ' concept as accessible print-ready files.'), deliverables, qaChecklist,
    constraints: ['No publication, marketplace mutation, account creation, purchase, subscription, or spending', 'Real artifacts must use existing Workshop/file provenance'].concat(plan.constraints), priority: plan.priority });
  return Object.assign({}, result, { schema: 'pine-star.pine-trail-production-plan.v1', preset: { family, deliverables, qaChecklist }, externalAction: false, spendingAuthorityUsd: 0 });
}
module.exports = { FAMILIES, normalizePineTrailPrintable, intakePineTrailPrintable, normalizePineTrailProduction, planPineTrailProduction };
