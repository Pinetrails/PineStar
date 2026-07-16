'use strict';
const A = require('./_assert.js');
const D = require('../frontend/app/deliverables.js');

const md = D.safeMarkdown('# Hello\n<script>alert(1)</script>\n**bold**');
A.ok(md.indexOf('<h1>Hello</h1>') >= 0 && md.indexOf('<strong>bold</strong>') >= 0, 'bounded Markdown formatting renders');
A.ok(md.indexOf('<script>') < 0 && md.indexOf('&lt;script&gt;') >= 0, 'Markdown HTML is escaped before formatting');

const csv = D.safeCsv('a,b,c\n1,"two, too",3\n4,5,6', 2, 2);
A.ok(csv.indexOf('<table') >= 0 && csv.indexOf('two, too') >= 0, 'quoted CSV cells parse into a table');
A.ok(csv.indexOf('<td>3</td>') < 0 && csv.indexOf('<td>4</td>') < 0, 'CSV preview obeys row and column bounds');

A.eq(D.openUrl('/workshop-run/a/r/index.html', 'secret'), '/workshop-run/a/r/index.html?token=secret', 'sandboxed HTML navigation receives the launch token');
A.eq(D.openUrl('/api/file?agent=a&path=x.md', 'secret'), '/api/file?agent=a&path=x.md&token=secret', 'file preview receives the launch token');
A.report('deliverables-ui.test');
