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
A.ok(src.indexOf('newWorkstreamCommand') >= 0 && src.indexOf('branchWorkstreamCommand') >= 0, 'palette maps workflow commands to workstream handlers');
A.ok(src.indexOf('usageCommand') >= 0 && src.indexOf('statusCommand') >= 0, 'palette maps usage and status commands');
A.ok(src.indexOf('modelCommand') >= 0 && src.indexOf('personalityCommand') >= 0 && src.indexOf('yoloCommand') >= 0, 'palette maps config commands');
A.ok(src.indexOf('toolsCommand') >= 0 && src.indexOf('skillsCommand') >= 0 && src.indexOf('reloadSkillsCommand') >= 0, 'palette maps tools and skills commands');
A.ok(src.indexOf('/api/slash/catalog') >= 0, 'palette fetches the sidecar slash catalog');
A.ok(src.indexOf('/api/slash/dispatch') >= 0, 'palette dispatches server-backed commands through the sidecar');
A.ok(src.indexOf('slashPlacedTypes') >= 0 && src.indexOf('World.heroCaps') >= 0, 'palette asks the sidecar for commands matching the active agent capabilities');
A.ok(src.indexOf('Recipes.list') >= 0 && src.indexOf("source: 'recipe'") >= 0, 'palette preserves recipe slash commands');
A.ok(src.indexOf("directive.type === 'insert'") >= 0, 'palette applies insert directives from skill and recipe commands');
A.ok(src.indexOf('rawInput') >= 0, 'palette preserves typed slash arguments during dispatch');
A.ok(src.indexOf('serverBacked && await dispatchSlash') >= 0, 'server-backed commands try dispatch before local fallback');

A.report('slash.palette.test');
