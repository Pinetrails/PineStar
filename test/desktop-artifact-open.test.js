/* node test/desktop-artifact-open.test.js — source contract for saved-file desktop actions.
 *
 * The browser preview remains a real /api/file link. In the packaged desktop, the filename
 * opens only a canonical, existing, non-executable artifact through its OS association; the
 * folder control reveals that exact artifact; copy-path resolves relative workspace paths to
 * their full path. The Rust host owns containment so renderer IPC is not an arbitrary launcher.
 */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const chat = fs.readFileSync(path.join(__dirname, '../frontend/app/chat.js'), 'utf8');
const rust = fs.readFileSync(path.join(__dirname, '../src-tauri/src/main.rs'), 'utf8');

A.ok(/core\.invoke\('starnet_open_artifact', \{ path: String\(title \|\| ''\), agentId: agentId \|\| 'agent' \}\)/.test(chat),
  'desktop filename click sends artifact identity + owner to the native host');
A.ok(/core\.invoke\('open_external_url', \{ url: a\.href \}\)/.test(chat),
  'the jailed browser preview remains the desktop fallback');
A.ok(/core\.invoke\('starnet_reveal_path', \{ path: String\(relPath \|\| ''\), agentId: agentId \|\| 'agent' \}\)/.test(chat),
  'folder click reveals the artifact path itself, not the default workspace root');
A.ok(/function absoluteArtifactPath[\s\S]{0,700}workspaceDir\(agentId\)/.test(chat),
  'relative deliverables resolve against the authoritative agent workspace for clipboard use');
A.ok(/copyText\(abs\)/.test(chat) && /copy path/.test(chat),
  'copy-path is explicit and copies the resolved absolute path');

A.ok(/fn starnet_open_artifact[\s\S]{0,500}resolve_artifact_path/.test(rust),
  'native open always passes through the artifact resolver');
A.ok(/fn starnet_reveal_path[\s\S]{0,500}resolve_artifact_path/.test(rust),
  'native reveal always passes through the same artifact resolver');
A.ok(/std::fs::canonicalize\(&candidate\)/.test(rust) && /path_is_within\(&canonical, &root\)/.test(rust),
  'the host canonicalizes symlinks and proves root containment');
A.ok(/artifact_path_hits_hard_floor/.test(rust) && /value == "\.git"/.test(rust) && /value == "\.env"/.test(rust),
  'protected .git/.env paths remain below the native-open floor');
A.ok(/safe_native_artifact_extension[\s\S]{0,900}"md"/.test(rust),
  'Markdown is allowed through the OS default association');
A.ok(!/safe_native_artifact_extension[\s\S]{0,900}"exe"/.test(rust),
  'executable files are not allowlisted for native opening');
A.ok(/starnet_open_artifact,\s*starnet_reveal_path,/.test(rust),
  'both constrained commands are registered with Tauri');

A.report('desktop-artifact-open.test');
