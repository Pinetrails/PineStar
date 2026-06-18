/* node test/summon.id.test.js — AgentId.alloc: a stable, unique, backend-valid id for a SUMMONED agent.
   The id keys the notebook / fs jail / cost / run loop (^[A-Za-z0-9_-]{1,40}$), is never the hero's
   reserved 'agent', and never collides with the live roster. Pure — no DOM. */
'use strict';
const A = require('./_assert.js');
const AgentId = require('../frontend/app/agentid.js');

// ---- slug(): sanitize any seed to a valid base ----
{
  A.ok(AgentId.RE.test(AgentId.slug('Research Analyst')), 'a spaced name slugs to a valid base');
  A.eq(AgentId.slug('Research Analyst'), 'research-analyst', 'spaces -> dashes, lowercased');
  A.eq(AgentId.slug('  ***  '), 'agent', 'an all-junk seed falls back to "agent"');
  A.eq(AgentId.slug(''), 'agent', 'an empty seed falls back to "agent"');
  A.ok(AgentId.slug('x'.repeat(99)).length <= 32, 'an overlong seed is capped at 32');
}

// ---- alloc(): valid, never 'agent', unique vs a growing roster ----
{
  const taken = new Set(['agent']);   // the hero is always reserved
  const ids = [];
  for (let i = 0; i < 60; i++) {
    const id = AgentId.alloc('researcher', taken);
    A.ok(AgentId.RE.test(id), 'alloc #' + i + ' matches the backend id grammar: ' + id);
    A.ok(id !== 'agent', 'alloc never returns the hero id');
    A.ok(!taken.has(id), 'alloc is unique vs the growing roster: ' + id);
    taken.add(id); ids.push(id);
  }
  A.eq(new Set(ids).size, ids.length, 'every allocated id is distinct');
}

// ---- a seed that sanitizes to 'agent' is still bumped off the hero id ----
{
  const id = AgentId.alloc('agent', new Set(['agent']));
  A.ok(id !== 'agent' && AgentId.RE.test(id), 'a seed of "agent" -> a valid non-hero id: ' + id);
}

// ---- no `taken` set degrades gracefully ----
{
  const id = AgentId.alloc('builder');
  A.ok(AgentId.RE.test(id) && id !== 'agent', 'alloc with no taken-set still yields a valid non-hero id');
}

A.report('summon.id.test');
