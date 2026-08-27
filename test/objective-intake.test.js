'use strict';
const A = require('./_assert.js');
const { classifyObjective } = require('../sidecar/objective-intake.js');

const research = classifyObjective({ title: 'Research and compare the source material' });
A.eq(research.requiredCapabilities, ['research', 'verify'], 'obvious research intake is classified deterministically');
A.eq(research.classification.method, 'deterministic-v1', 'deterministic classification is recorded');
const code = classifyObjective({ title: 'Fix the software bug' });
A.eq(code.requiredCapabilities, ['code', 'test'], 'obvious software work declares specialist capabilities');
const explicit = classifyObjective({ title: 'Review this', requiredCapabilities: ['report'] });
A.eq(explicit.requiredCapabilities, ['report'], 'explicit capabilities remain authoritative');
A.eq(explicit.classification.method, 'declared', 'declared classification is auditable');
A.eq(classifyObjective({ title: 'An unknown request' }).requiredCapabilities, [], 'unknown work is not guessed into a privileged capability');
A.report('objective-intake.test');
