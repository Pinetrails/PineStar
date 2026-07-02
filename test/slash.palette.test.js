/* node test/slash.palette.test.js -- lightweight regression pins for the chat slash palette wiring. */
'use strict';

const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'chat.js'), 'utf8');

A.ok(src.indexOf('FALLBACK_SLASH_COMMANDS') >= 0, 'palette keeps local fallback commands');
A.ok(src.indexOf("name: 'retry'") >= 0 && src.indexOf("name: 'stop'") >= 0, 'palette fallback includes retry and stop');
A.ok(src.indexOf("name: 'copy'") >= 0 && src.indexOf("name: 'help'") >= 0, 'palette fallback includes copy and help');
A.ok(src.indexOf("name: 'new'") >= 0 && src.indexOf("name: 'branch'") >= 0, 'palette fallback includes new and branch');
A.ok(src.indexOf("name: 'queue'") >= 0 && src.indexOf("name: 'steer'") >= 0, 'palette fallback includes queue and steer');
A.ok(src.indexOf("name: 'undo'") >= 0 && src.indexOf("name: 'compress'") >= 0, 'palette fallback includes undo and compress');
A.ok(src.indexOf("name: 'model'") >= 0 && src.indexOf("name: 'personality'") >= 0, 'palette fallback includes model and personality');
A.ok(src.indexOf("name: 'yolo'") >= 0 && src.indexOf("name: 'tools'") >= 0, 'palette fallback includes yolo and tools');
A.ok(src.indexOf("name: 'skills'") >= 0 && src.indexOf("name: 'reload-skills'") >= 0, 'palette fallback includes skills and reload-skills');
A.ok(src.indexOf("name: 'debug'") >= 0, 'palette fallback includes debug');
A.ok(src.indexOf("name: 'title'") >= 0 && src.indexOf("name: 'resume'") >= 0, 'palette fallback includes title and resume');
A.ok(src.indexOf("name: 'agents'") >= 0 && src.indexOf("name: 'background'") >= 0, 'palette fallback includes agents and background');
A.ok(src.indexOf("name: 'goal'") >= 0 && src.indexOf("name: 'subgoal'") >= 0, 'palette fallback includes goal and subgoal');
A.ok(src.indexOf("name: 'memory'") >= 0 && src.indexOf("name: 'bundles'") >= 0, 'palette fallback includes memory and bundles');
A.ok(src.indexOf("name: 'cron'") >= 0 && src.indexOf("name: 'suggestions'") >= 0, 'palette fallback includes cron and suggestions');
A.ok(src.indexOf("name: 'blueprint'") >= 0 && src.indexOf("name: 'reload-mcp'") >= 0, 'palette fallback includes blueprint and reload-mcp');
A.ok(src.indexOf("name: 'reasoning'") >= 0 && src.indexOf("name: 'fast'") >= 0 && src.indexOf("name: 'voice'") >= 0, 'palette fallback includes mode commands');
A.ok(src.indexOf("name: 'version'") >= 0, 'palette fallback includes version');
A.ok(src.indexOf('newWorkstreamCommand') >= 0 && src.indexOf('branchWorkstreamCommand') >= 0, 'palette maps workflow commands to workstream handlers');
A.ok(src.indexOf('usageCommand') >= 0 && src.indexOf('statusCommand') >= 0, 'palette maps usage and status commands');
A.ok(src.indexOf('titleCommand') >= 0 && src.indexOf('resumeCommand') >= 0 && src.indexOf('backgroundCommand') >= 0, 'palette maps Plan5 session commands');
A.ok(src.indexOf('agentsCommand') >= 0 && src.indexOf('goalCommand') >= 0 && src.indexOf('subgoalCommand') >= 0, 'palette maps agent and goal commands');
A.ok(src.indexOf('modelCommand') >= 0 && src.indexOf('personalityCommand') >= 0 && src.indexOf('yoloCommand') >= 0, 'palette maps config commands');
A.ok(src.indexOf('reasoningCommand') >= 0 && src.indexOf('fastCommand') >= 0 && src.indexOf('voiceCommand') >= 0, 'palette maps mode commands');
A.ok(src.indexOf('toolsCommand') >= 0 && src.indexOf('skillsCommand') >= 0 && src.indexOf('reloadSkillsCommand') >= 0, 'palette maps tools and skills commands');
A.ok(src.indexOf('memoryCommand') >= 0 && src.indexOf('bundlesCommand') >= 0 && src.indexOf('cronCommand') >= 0, 'palette maps Plan6 status commands');
A.ok(src.indexOf('suggestionsCommand') >= 0 && src.indexOf('blueprintCommand') >= 0 && src.indexOf('reloadMcpCommand') >= 0, 'palette maps Plan6 action commands');
A.ok(src.indexOf('versionCommand') >= 0, 'palette maps version command');
A.ok(src.indexOf('/api/slash/catalog') >= 0, 'palette fetches the sidecar slash catalog');
A.ok(src.indexOf('/api/slash/dispatch') >= 0, 'palette dispatches server-backed commands through the sidecar');
A.ok(src.indexOf('/api/cron') >= 0 && src.indexOf('/api/connectors/refresh') >= 0, 'palette uses real cron and MCP endpoints');
A.ok(src.indexOf('slashPlacedTypes') >= 0 && src.indexOf('World.heroCaps') >= 0, 'palette asks the sidecar for commands matching the active agent capabilities');
A.ok(src.indexOf('Recipes.list') >= 0 && src.indexOf("source: 'recipe'") >= 0, 'palette preserves recipe slash commands');
A.ok(src.indexOf('MintStore.candidates') >= 0 && src.indexOf('Recipes.saveCustom') >= 0, 'palette wires recurring-task suggestions to recipe saves');
A.ok(src.indexOf("directive.type === 'insert'") >= 0, 'palette applies insert directives from skill and recipe commands');
A.ok(src.indexOf('rawInput') >= 0, 'palette preserves typed slash arguments during dispatch');
A.ok(src.indexOf('serverBacked && await dispatchSlash') >= 0, 'server-backed commands try dispatch before local fallback');

A.report('slash.palette.test');
