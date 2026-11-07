use serde::{Deserialize, Serialize};
use std::{cmp::Ordering, fmt, path::PathBuf};
use windows_sys::Win32::Globalization::CompareStringOrdinal;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub schema: u32,
    pub home: String,
    pub node_path: String,
    pub watcher_dir: String,
    #[serde(
        default,
        deserialize_with = "optional_string",
        skip_serializing_if = "Option::is_none"
    )]
    pub namespace: Option<String>,
    pub state_dir: String,
    #[serde(
        default,
        deserialize_with = "optional_string",
        skip_serializing_if = "Option::is_none"
    )]
    pub test_run_key: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ConfigError {
    pub field: &'static str,
    pub kind: &'static str,
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} {}", self.field, self.kind)
    }
}

impl std::error::Error for ConfigError {}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LaunchPlan {
    pub application: String,
    pub command_line: String,
    pub current_directory: String,
    pub flags: u32,
    pub inherit_handles: bool,
    pub environment: Vec<(String, String)>,
}

fn optional_string<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    String::deserialize(deserializer).map(Some)
}

fn has_object_root(bytes: &[u8]) -> bool {
    bytes
        .iter()
        .copied()
        .find(|byte| !matches!(byte, b' ' | b'\t' | b'\r' | b'\n'))
        == Some(b'{')
}

pub fn parse_config(bytes: &[u8]) -> Result<Config, ConfigError> {
    if !has_object_root(bytes) {
        return Err(ConfigError {
            field: "config",
            kind: "expected object",
        });
    }
    let config: Config = serde_json::from_slice(bytes).map_err(|_| ConfigError {
        field: "config",
        kind: "invalid JSON or fields",
    })?;
    if config.schema != 1 {
        return Err(ConfigError {
            field: "schema",
            kind: "unsupported",
        });
    }
    for (field, path) in [
        ("home", &config.home),
        ("nodePath", &config.node_path),
        ("watcherDir", &config.watcher_dir),
        ("stateDir", &config.state_dir),
    ] {
        if !validate_drive_path(path) {
            return Err(ConfigError {
                field,
                kind: "invalid path",
            });
        }
    }
    if config.node_path.ends_with(['\\', '/']) {
        return Err(ConfigError {
            field: "nodePath",
            kind: "trailing separator",
        });
    }
    if config
        .namespace
        .as_deref()
        .is_some_and(|value| !valid_namespace(value))
    {
        return Err(ConfigError {
            field: "namespace",
            kind: "invalid",
        });
    }
    Ok(config)
}

pub fn config_log_directory(bytes: &[u8]) -> Option<PathBuf> {
    if !has_object_root(bytes) {
        return None;
    }
    #[derive(Deserialize)]
    struct LogDirectory {
        #[serde(rename = "stateDir")]
        state_dir: String,
    }
    let partial: LogDirectory = serde_json::from_slice(bytes).ok()?;
    if !validate_drive_path(&partial.state_dir) {
        return None;
    }
    let path = PathBuf::from(partial.state_dir);
    path.is_dir().then_some(path)
}

pub fn valid_namespace(value: &str) -> bool {
    (1..=16).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
}

pub fn validate_drive_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && bytes[2] == b'\\'
        && !value.contains(['"', '\0'])
}

pub fn validate_test_run_key(value: &str) -> bool {
    if value.contains(['\0', '/']) {
        return false;
    }
    let segments: Vec<_> = value.split('\\').collect();
    segments.len() >= 3
        && segments
            .iter()
            .all(|segment| !segment.is_empty() && *segment != "." && *segment != "..")
        && segments[0].eq_ignore_ascii_case("Software")
        && segments[1].eq_ignore_ascii_case("HOAI-Test")
}

fn compare_names(left: &str, right: &str) -> Ordering {
    let left: Vec<_> = left.encode_utf16().collect();
    let right: Vec<_> = right.encode_utf16().collect();
    // Names originate in the bounded Windows environment block, so their
    // lengths fit the API's signed character-count parameters.
    let result = unsafe {
        CompareStringOrdinal(
            left.as_ptr(),
            left.len() as i32,
            right.as_ptr(),
            right.len() as i32,
            1,
        )
    };
    match result {
        1 => Ordering::Less,
        2 => Ordering::Equal,
        3 => Ordering::Greater,
        _ => left.cmp(&right),
    }
}

pub fn build_launch_plan(config: &Config, inherited: &[(String, String)]) -> LaunchPlan {
    let mut environment: Vec<_> = inherited
        .iter()
        .filter(|(name, _)| {
            !["USERPROFILE", "HOAI_SERVICE_NAMESPACE", "NODE_OPTIONS"]
                .iter()
                .any(|removed| compare_names(name, removed) == Ordering::Equal)
        })
        .cloned()
        .collect();
    environment.push(("USERPROFILE".into(), config.home.clone()));
    if let Some(namespace) = &config.namespace {
        environment.push(("HOAI_SERVICE_NAMESPACE".into(), namespace.clone()));
    }
    environment.sort_by(|(left, _), (right, _)| compare_names(left, right));
    let watcher = format!(
        "{}\\bin\\hoai-watcher.mjs",
        config.watcher_dir.trim_end_matches(['\\', '/'])
    );
    LaunchPlan {
        application: config.node_path.clone(),
        command_line: format!("\"{}\" \"{}\" run", config.node_path, watcher),
        current_directory: config.watcher_dir.clone(),
        flags: 0x08000400,
        inherit_handles: false,
        environment,
    }
}

pub fn environment_block(entries: &[(String, String)]) -> Vec<u16> {
    let mut block = Vec::new();
    for (name, value) in entries {
        block.extend(name.encode_utf16());
        block.push(b'=' as u16);
        block.extend(value.encode_utf16());
        block.push(0);
    }
    if block.is_empty() {
        block.push(0);
    }
    block.push(0);
    block
}
