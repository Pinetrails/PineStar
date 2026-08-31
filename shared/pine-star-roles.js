/* Pine Star system-role seeds. Roles are routing/configuration records, not visible agent identities. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PineStarRoles = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const SEEDS = [
    { id: 'operations.coordinator', displayName: 'Coordinator', department: 'operations', capabilities: ['coordinate', 'triage', 'report'], modelTier: 'balanced', escalationTargets: [], permissions: { protectedActions: false }, availability: 'active' },
    { id: 'operations.auditor', displayName: 'Auditor', department: 'operations', capabilities: ['audit', 'report', 'verify'], modelTier: 'economy', escalationTargets: ['operations.coordinator'], permissions: { protectedActions: false }, availability: 'active' },
    { id: 'operations.open_source_scout', displayName: 'Daily Open-Source Scout', department: 'operations', capabilities: ['discover_open_source', 'research', 'recommend'], modelTier: 'economy', escalationTargets: ['development.integration_engineer', 'operations.coordinator'], permissions: { protectedActions: false, installSoftware: false }, availability: 'active' },
    { id: 'development.integration_engineer', displayName: 'Integration Engineer', department: 'development', capabilities: ['evaluate_integration', 'test_integration', 'code'], modelTier: 'balanced', escalationTargets: ['operations.coordinator'], permissions: { protectedActions: false, installSoftware: false }, availability: 'active' },
    { id: 'development.software_engineer', displayName: 'Software Engineer', department: 'development', capabilities: ['code', 'test', 'debug'], modelTier: 'balanced', escalationTargets: ['operations.coordinator'], permissions: { protectedActions: false }, availability: 'active' },
    { id: 'research.general_researcher', displayName: 'Researcher', department: 'research', capabilities: ['research', 'verify', 'summarize'], modelTier: 'economy', escalationTargets: ['operations.coordinator'], permissions: { protectedActions: false }, availability: 'active' },
    { id: 'business.idea_lab', displayName: 'Idea Lab', department: 'business', capabilities: ['product_ideation', 'recommend', 'summarize'], modelTier: 'economy', escalationTargets: ['operations.coordinator'], permissions: { protectedActions: false, publish: false, spend: false }, availability: 'active' },
    { id: 'business.product_designer', displayName: 'Product Designer', department: 'business', capabilities: ['specify_product', 'prepare_product'], modelTier: 'balanced', escalationTargets: ['operations.coordinator'], permissions: { protectedActions: false, publish: false, spend: false }, availability: 'active' },
    { id: 'business.growth_analyst', displayName: 'Growth Analyst', department: 'business', capabilities: ['design_growth_experiment', 'analyze_growth_experiment'], modelTier: 'economy', escalationTargets: ['operations.coordinator', 'operations.auditor'], permissions: { protectedActions: false, publish: false, outreach: false, spend: false, createAccounts: false }, availability: 'active' },
    { id: 'operations.quality_reviewer', displayName: 'Quality Reviewer', department: 'operations', capabilities: ['quality_review', 'verify'], modelTier: 'economy', escalationTargets: ['operations.auditor', 'operations.coordinator'], permissions: { protectedActions: false, publish: false }, availability: 'active' }
  ];
  return { SEEDS };
});
