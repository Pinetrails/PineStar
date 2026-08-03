//! Native credential storage and one-time channel-token migration.
//!
//! The WebView-facing Tauri commands live in `main.rs`; this module owns the OS
//! keychain namespace, provider/channel normalization, secret reads, and the
//! crash-safe migration of legacy plaintext channel tokens.

use std::path::Path;

pub(crate) const KEYCHAIN_SERVICE: &str = "ai.skynet.harness";
pub(crate) const KEYCHAIN_ACCOUNT: &str = "openrouter";
pub(crate) const KEYCHAIN_PROVIDERS: [&str; 13] = [
    "openrouter",
    "openai",
    "anthropic",
    "gemini",
    "xai",
    "groq",
    "mistral",
    "deepseek",
    "together",
    "fireworks",
    "perplexity",
    "cerebras",
    "custom",
];

// Channel bot tokens live under account "channel:<id>" and inject into the sidecar env.
// (id, env_name) drives spawn injection and the store/has commands.
pub(crate) const SIDECAR_CHANNEL_TOKEN_ENVS: [(&str, &str); 2] = [
    ("telegram", "SKYNET_TELEGRAM_TOKEN"),
    ("discord", "SKYNET_DISCORD_TOKEN"),
];

pub(crate) const SIDECAR_PROVIDER_KEY_ENVS: [(&str, &str); 12] = [
    ("openai", "SKYNET_OPENAI_API_KEY"),
    ("anthropic", "SKYNET_ANTHROPIC_API_KEY"),
    ("gemini", "SKYNET_GEMINI_API_KEY"),
    ("xai", "SKYNET_XAI_API_KEY"),
    ("groq", "SKYNET_GROQ_API_KEY"),
    ("mistral", "SKYNET_MISTRAL_API_KEY"),
    ("deepseek", "SKYNET_DEEPSEEK_API_KEY"),
    ("together", "SKYNET_TOGETHER_API_KEY"),
    ("fireworks", "SKYNET_FIREWORKS_API_KEY"),
    ("perplexity", "SKYNET_PERPLEXITY_API_KEY"),
    ("cerebras", "SKYNET_CEREBRAS_API_KEY"),
    ("custom", "SKYNET_CUSTOM_OPENAI_KEY"),
];

pub(crate) fn normalize_provider(provider: &str) -> &'static str {
    match provider.trim().to_ascii_lowercase().as_str() {
        "codex" | "openai-codex" => "codex",
        "openai" | "openai-api" => "openai",
        "anthropic" | "claude" => "anthropic",
        "gemini" | "google" | "google-ai" | "google-gemini" => "gemini",
        "grok" | "grok-oauth" | "xai-oauth" => "grok",
        "kimi" | "moonshot" | "kimi-code" | "kimi-oauth" => "kimi",
        "xai" | "x-ai" => "xai",
        "groq" => "groq",
        "mistral" | "mistralai" => "mistral",
        "deepseek" => "deepseek",
        "together" | "together-ai" => "together",
        "fireworks" | "fireworks-ai" => "fireworks",
        "perplexity" | "pplx" | "sonar" => "perplexity",
        "cerebras" => "cerebras",
        "ollama" | "ollama-local" => "ollama",
        "custom" | "openai-compatible" | "local" | "vllm" | "lmstudio" => "custom",
        _ => "openrouter",
    }
}

pub(crate) fn keychain_account_for(provider: &str) -> String {
    match normalize_provider(provider) {
        // Preserve the original account name so existing OpenRouter keys keep working.
        "openrouter" => KEYCHAIN_ACCOUNT.to_string(),
        id => format!("provider:{id}"),
    }
}

pub(crate) fn keychain_entry() -> keyring::Result<keyring::Entry> {
    keychain_entry_for("openrouter")
}

pub(crate) fn keychain_entry_for(provider: &str) -> keyring::Result<keyring::Entry> {
    let account = keychain_account_for(provider);
    keyring::Entry::new(KEYCHAIN_SERVICE, account.as_str())
}

pub(crate) fn keychain_pool_entry_for(provider: &str) -> keyring::Result<keyring::Entry> {
    let account = format!("{}:pool", keychain_account_for(provider));
    keyring::Entry::new(KEYCHAIN_SERVICE, account.as_str())
}

/// The stored OpenRouter BYOK key, or `None` if unset/empty.
pub(crate) fn read_key() -> Option<String> {
    read_key_for("openrouter")
}

pub(crate) fn read_key_for(provider: &str) -> Option<String> {
    keychain_entry_for(provider)
        .ok()
        .and_then(|entry| entry.get_password().ok())
        .filter(|key| !key.trim().is_empty())
}

pub(crate) fn read_key_pool_for(provider: &str) -> Vec<String> {
    keychain_pool_entry_for(provider)
        .ok()
        .and_then(|entry| entry.get_password().ok())
        .and_then(|raw| serde_json::from_str::<Vec<String>>(&raw).ok())
        .unwrap_or_default()
        .into_iter()
        .map(|key| key.trim().to_string())
        .filter(|key| !key.is_empty())
        .take(8)
        .collect()
}

/// Only channels the native shell injects may occupy the `channel:<id>` namespace.
pub(crate) fn is_known_channel(channel: &str) -> bool {
    SIDECAR_CHANNEL_TOKEN_ENVS
        .iter()
        .any(|(id, _)| *id == channel)
}

fn channel_keychain_account(channel: &str) -> String {
    format!("channel:{channel}")
}

pub(crate) fn channel_keychain_entry(channel: &str) -> keyring::Result<keyring::Entry> {
    let account = channel_keychain_account(channel);
    keyring::Entry::new(KEYCHAIN_SERVICE, account.as_str())
}

/// Delete a keychain credential, treating "nothing stored" as success. A real deletion
/// failure surfaces so callers cannot claim a credential was purged while it still exists.
pub(crate) fn delete_credential_honest(entry: &keyring::Entry) -> Result<(), String> {
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

pub(crate) fn restore_credential(
    entry: &keyring::Entry,
    previous: Option<&str>,
) -> Result<(), String> {
    match previous {
        Some(value) => entry.set_password(value).map_err(|error| error.to_string()),
        None => delete_credential_honest(entry),
    }
}

pub(crate) fn rollback_error(primary: String, failures: Vec<String>) -> String {
    if failures.is_empty() {
        primary
    } else {
        format!("{primary}; rollback incomplete: {}", failures.join("; "))
    }
}

/// The stored bot token for a channel, or `None` if unset/empty.
pub(crate) fn read_channel_token(channel: &str) -> Option<String> {
    channel_keychain_entry(channel)
        .ok()
        .and_then(|entry| entry.get_password().ok())
        .filter(|token| !token.trim().is_empty())
}

/// Import plaintext channel bot tokens from legacy `secrets.json` into the OS keychain.
/// A plaintext token is removed only after read-back proves the exact value arrived.
pub(crate) fn migrate_channel_tokens_from_plaintext(workspaces: &Path) {
    let file = workspaces.join("channels").join("secrets.json");
    let raw = match std::fs::read_to_string(&file) {
        Ok(raw) => raw,
        Err(_) => return,
    };
    let mut json: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(json) => json,
        Err(_) => return,
    };

    let mut changed = false;
    for (channel, _) in SIDECAR_CHANNEL_TOKEN_ENVS {
        let token = json
            .get(channel)
            .and_then(|record| record.get("token"))
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);

        if let Some(token) = token {
            if read_channel_token(channel).is_none() {
                if let Ok(entry) = channel_keychain_entry(channel) {
                    let _ = entry.set_password(&token);
                }
            }

            // Never destroy the last copy: verify the exact destination value first.
            let keychain_has_it = read_channel_token(channel)
                .map(|stored| stored == token)
                .unwrap_or(false);
            if keychain_has_it {
                if let Some(record) = json
                    .get_mut(channel)
                    .and_then(|value| value.as_object_mut())
                {
                    record.remove("token");
                    changed = true;
                }
            }
        }
    }

    if changed {
        if let Ok(serialized) = serde_json::to_string(&json) {
            let _ = atomic_write(&file, serialized.as_bytes());
        }
    }
}

/// Write bytes through a sibling temp file, flush, then rename over the target.
fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;

    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("secrets.json"),
        std::process::id()
    ));
    {
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        file.flush()?;
        let _ = file.sync_all();
    }

    #[cfg(windows)]
    {
        if path.exists() {
            let _ = std::fs::remove_file(path);
        }
    }
    match std::fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(error) => {
            let _ = std::fs::remove_file(&tmp);
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_aliases_normalize_to_runtime_ids() {
        let cases = [
            (" OpenAI-API ", "openai"),
            ("claude", "anthropic"),
            ("google-gemini", "gemini"),
            ("grok-oauth", "grok"),
            ("x-ai", "xai"),
            ("moonshot", "kimi"),
            ("pplx", "perplexity"),
            ("ollama-local", "ollama"),
            ("lmstudio", "custom"),
            ("unknown-provider", "openrouter"),
        ];
        for (input, expected) in cases {
            assert_eq!(normalize_provider(input), expected, "alias {input}");
        }
    }

    #[test]
    fn keychain_accounts_preserve_legacy_openrouter_slot() {
        assert_eq!(keychain_account_for("openrouter"), "openrouter");
        assert_eq!(keychain_account_for("unknown"), "openrouter");
        assert_eq!(keychain_account_for("openai-api"), "provider:openai");
        assert_eq!(keychain_account_for("claude"), "provider:anthropic");
    }

    #[test]
    fn channel_namespace_is_closed_and_env_mapping_is_stable() {
        assert!(is_known_channel("telegram"));
        assert!(is_known_channel("discord"));
        assert!(!is_known_channel("Telegram"));
        assert!(!is_known_channel("matrix"));
        assert_eq!(channel_keychain_account("telegram"), "channel:telegram");
        assert_eq!(
            SIDECAR_CHANNEL_TOKEN_ENVS,
            [
                ("telegram", "SKYNET_TELEGRAM_TOKEN"),
                ("discord", "SKYNET_DISCORD_TOKEN"),
            ]
        );
    }

    #[test]
    fn rollback_errors_never_hide_incomplete_restoration() {
        assert_eq!(
            rollback_error("push failed".to_string(), Vec::new()),
            "push failed"
        );
        assert_eq!(
            rollback_error(
                "push failed".to_string(),
                vec!["keychain restore failed".to_string()],
            ),
            "push failed; rollback incomplete: keychain restore failed"
        );
    }
}
