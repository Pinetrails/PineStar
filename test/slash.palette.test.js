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
A.ok(src.indexOf('newWorkstreamCommand') >= 0 && src.indexOf('branchWorkstreamCommand') >= 0, 'palette maps workflow commands to workstream handlers');
A.ok(src.indexOf('usageCommand') >= 0 && src.indexOf('statusCommand') >= 0, 'palette maps usage and status commands');
A.ok(src.indexOf('/api/slash/catalog') >= 0, 'palette fetches the sidecar slash catalog');
A.ok(src.indexOf('/api/slash/dispatch') >= 0, 'palette dispatches server-backed commands through the sidecar');
A.ok(src.indexOf('slashPlacedTypes') >= 0 && src.indexOf('World.heroCaps') >= 0, 'palette asks the sidecar for commands matching the active agent capabilities');
A.ok(src.indexOf('Recipes.list') >= 0 && src.indexOf("source: 'recipe'") >= 0, 'palette preserves recipe slash commands');
A.ok(src.indexOf("directive.type === 'insert'") >= 0, 'palette applies insert directives from skill and recipe commands');
A.ok(src.indexOf('rawInput') >= 0, 'palette preserves typed slash arguments during dispatch');
A.ok(src.indexOf('serverBacked && await dispatchSlash') >= 0, 'server-backed commands try dispatch before local fallback');

A.report('slash.palette.test');
