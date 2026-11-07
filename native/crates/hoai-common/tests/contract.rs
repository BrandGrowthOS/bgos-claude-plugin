use hoai_common::{
    build_launch_plan, canonical_home, config_log_directory, environment_block, helper_value_name,
    home_id, mutex_name, next_failure_count, parse_config, restart_delay, sha256_hex,
    valid_namespace, validate_drive_path, validate_test_run_key, Config,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{fs, path::Path, time::Duration};

fn example_config() -> Config {
    Config {
        schema: 1,
        home: "E:\\glass home".into(),
        node_path: "E:\\node folder\\node.exe".into(),
        watcher_dir: "E:\\watcher folder\\\\".into(),
        namespace: Some("glass1".into()),
        state_dir: "E:\\state".into(),
        test_run_key: Some("Software\\HOAI-Test\\glasshelper\\example\\Run".into()),
    }
}

fn sample_json() -> Value {
    serde_json::to_value(example_config()).unwrap()
}

#[test]
fn workspace_manifest_and_lock_are_exact() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let manifest = fs::read_to_string(root.join("Cargo.toml")).unwrap();
    assert!(
        manifest.contains("rust-version = \"1.95\""),
        "NAT-1 MSRV is exact"
    );
    assert!(manifest.contains("crates/hoai-common"));
    assert!(manifest.contains("crates/hoai-helper"));
    assert!(manifest.contains("edition = \"2021\""));
    assert!(root.join("Cargo.lock").is_file());
    assert!(!root.join("rust-toolchain").exists());
    assert!(!root.join("rust-toolchain.toml").exists());
    let mut in_dependencies = false;
    for line in manifest.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_dependencies = line.ends_with("dependencies]");
        } else if in_dependencies && line.contains('=') && !line.starts_with('#') {
            assert!(
                line.contains("\"="),
                "every workspace dependency pins an exact version: {line}"
            );
        }
    }
    for member in ["crates/hoai-common", "crates/hoai-helper"] {
        let text = fs::read_to_string(root.join(member).join("Cargo.toml")).unwrap();
        let mut in_dependencies = false;
        for line in text.lines() {
            let line = line.trim();
            if line.starts_with('[') {
                in_dependencies = line.ends_with("dependencies]");
            } else if in_dependencies && line.contains('=') && !line.starts_with('#') {
                assert!(
                    line.contains(".workspace = true") || line.contains("\"="),
                    "{member} dependency inherits or pins exactly: {line}"
                );
            }
        }
    }
}

#[test]
fn schema_one_rejects_unknown_and_invalid_fields() {
    let good = sample_json();
    assert!(parse_config(&serde_json::to_vec(&good).unwrap()).is_ok());
    for (name, bad) in [
        ("schema", json!(2)),
        ("schema", json!(1.0)),
        ("schema", json!("1")),
        ("home", json!(false)),
        ("namespace", json!("UPPER")),
        ("namespace", Value::Null),
        ("testRunKey", Value::Null),
        ("unexpected", json!("not allowed")),
    ] {
        let mut bad_config = good.clone();
        bad_config[name] = bad;
        assert!(
            parse_config(&serde_json::to_vec(&bad_config).unwrap()).is_err(),
            "field {name}"
        );
    }
    for name in ["schema", "home", "nodePath", "watcherDir", "stateDir"] {
        let mut missing = good.clone();
        missing.as_object_mut().unwrap().remove(name);
        assert!(
            parse_config(&serde_json::to_vec(&missing).unwrap()).is_err(),
            "missing {name}"
        );
    }
    let bytes = serde_json::to_string(&good).unwrap();
    let duplicate = bytes.replacen("\"schema\":1", "\"schema\":1,\"schema\":1", 1);
    assert!(parse_config(duplicate.as_bytes()).is_err());
    assert!(parse_config(format!("{bytes} false").as_bytes()).is_err());
    assert!(parse_config(format!("\u{feff}{bytes}").as_bytes()).is_err());
    let mut absent_optional = good;
    absent_optional.as_object_mut().unwrap().remove("namespace");
    absent_optional
        .as_object_mut()
        .unwrap()
        .remove("testRunKey");
    let parsed = parse_config(&serde_json::to_vec(&absent_optional).unwrap()).unwrap();
    assert_eq!(parsed.namespace, None);
    assert_eq!(parsed.test_run_key, None);
}

#[test]
fn namespace_is_exact_ascii_and_bounded() {
    for valid in ["a", "glass1", "0123456789abcdef"] {
        assert!(valid_namespace(valid), "valid {valid}");
    }
    for invalid in ["", "a-b", " a", "a ", "A", "é", "0123456789abcdefg", "a\n"] {
        assert!(!valid_namespace(invalid), "invalid {invalid:?}");
    }
}

#[test]
fn config_requires_absolute_drive_paths() {
    assert!(validate_drive_path("E:\\scratch"));
    for invalid in [
        "",
        "E:relative",
        "E:/scratch",
        "\\\\server\\share",
        "\\\\?\\E:\\scratch",
        "relative",
        "E:\\a\"b",
        "E:\\a\0b",
    ] {
        assert!(!validate_drive_path(invalid), "invalid path");
    }
    for field in ["home", "nodePath", "watcherDir", "stateDir"] {
        let mut value = sample_json();
        value[field] = json!("relative");
        assert!(parse_config(&serde_json::to_vec(&value).unwrap()).is_err());
    }
    let mut trailing_node = sample_json();
    trailing_node["nodePath"] = json!("E:\\node.exe\\");
    assert!(parse_config(&serde_json::to_vec(&trailing_node).unwrap()).is_err());
}

#[test]
fn test_run_key_prefix_is_validated_before_access() {
    assert!(validate_test_run_key(
        "Software\\HOAI-Test\\glasshelper\\one\\Run"
    ));
    assert!(validate_test_run_key(
        "software\\hoai-test\\glasshelper\\one\\run"
    ));
    for invalid in [
        "Software\\HOAI-Test",
        "Software\\HOAI-Test\\",
        "\\Software\\HOAI-Test\\one",
        "Software\\HOAI-Test\\one\\",
        "Software\\HOAI-Test\\\\one",
        "Software\\HOAI-Tested\\one",
        "Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce",
        "Software\\HOAI-Test\\one\0two",
        "Software\\HOAI-Test\\..\\Microsoft\\Windows\\CurrentVersion\\RunOnce",
        "Software\\HOAI-Test\\.\\one",
        "Software\\HOAI-Test\\one\\..",
    ] {
        assert!(!validate_test_run_key(invalid), "invalid test key");
    }
}

#[test]
fn bad_config_log_directory_requires_valid_existing_directory() {
    let runs = std::env::temp_dir().join("hoai-helper-tests").join("runs");
    fs::create_dir_all(&runs).unwrap();
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let folder = runs.join(format!("common-log-{}-{stamp}", std::process::id()));
    fs::create_dir(&folder).unwrap();
    let mut value = sample_json();
    value["schema"] = json!(99);
    value["stateDir"] = json!(folder.to_str().unwrap());
    let actual = config_log_directory(&serde_json::to_vec(&value).unwrap());
    let _ = fs::remove_dir(&folder);
    assert_eq!(actual, Some(folder));
    value["stateDir"] = json!("relative");
    assert_eq!(
        config_log_directory(&serde_json::to_vec(&value).unwrap()),
        None
    );
    assert_eq!(config_log_directory(b"{"), None);
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HomeVector {
    home: String,
    namespace: String,
    canonical: String,
    id: String,
    run_value_name: String,
}

fn vectors() -> Vec<HomeVector> {
    serde_json::from_str(include_str!("fixtures/home-vectors.json")).unwrap()
}

#[test]
fn canonical_home_matches_node_vectors() {
    for vector in vectors() {
        assert_eq!(
            canonical_home(&vector.home),
            vector.canonical,
            "home {:?}",
            vector.home
        );
    }
}

#[test]
fn home_names_match_node_vectors() {
    for vector in vectors() {
        let id = home_id(&vector.home);
        assert!(id.is_ok(), "home hashing must return a result");
        assert_eq!(id.unwrap(), vector.id);
        let namespace = if vector.namespace.is_empty() {
            None
        } else {
            Some(vector.namespace.as_str())
        };
        let name = helper_value_name(&vector.home, namespace);
        assert!(name.is_ok(), "helper naming must return a result");
        assert_eq!(name.unwrap(), vector.run_value_name);
    }
}

#[test]
fn sha256_matches_known_vectors() {
    let empty = sha256_hex(b"");
    assert!(empty.is_ok(), "SHA-256 must return a result");
    assert_eq!(
        empty.unwrap(),
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    let abc = sha256_hex(b"abc");
    assert!(abc.is_ok(), "SHA-256 must return a result");
    assert_eq!(
        abc.unwrap(),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
}

#[test]
fn mutex_name_has_sid_and_config_digest() {
    let expected_hash = sha256_hex(b"e:\\scratch\\config.json");
    assert!(expected_hash.is_ok(), "SHA-256 must precede mutex naming");
    let expected_hash = expected_hash.unwrap();
    assert!(
        expected_hash.len() >= 16,
        "SHA-256 must precede mutex naming"
    );
    let actual = mutex_name("S-1-5-21-1", "E:/Scratch/./config.json");
    assert!(actual.is_ok(), "mutex naming must return a result");
    let actual = actual.unwrap();
    assert_eq!(
        actual,
        format!("Local\\HOAI-Helper-S-1-5-21-1-{}", &expected_hash[..16])
    );
    assert_eq!(
        actual,
        mutex_name("S-1-5-21-1", "e:\\scratch\\config.json").unwrap()
    );
    assert_ne!(
        actual,
        mutex_name("S-1-5-21-2", "e:\\scratch\\config.json").unwrap()
    );
    assert_ne!(
        actual,
        mutex_name("S-1-5-21-1", "e:\\scratch\\other.json").unwrap()
    );
}

#[test]
fn restart_schedule_doubles_caps_and_resets() {
    let expected = [1, 2, 4, 8, 16, 32, 64, 128, 256, 300, 300];
    for (failures, seconds) in expected.into_iter().enumerate() {
        assert_eq!(
            restart_delay(failures as u32, 0),
            Duration::from_secs(seconds)
        );
    }
    assert_eq!(restart_delay(u32::MAX, 599), Duration::from_secs(300));
    assert_eq!(restart_delay(8, 600), Duration::from_secs(1));
    assert_eq!(restart_delay(u32::MAX, u64::MAX), Duration::from_secs(1));
}

#[test]
fn state_write_retries_up_to_five_times_on_sharing_or_access_errors() {
    for code in [5, 32] {
        for retries_done in 0..5 {
            assert!(
                hoai_common::state_retry_allowed(Some(code), retries_done),
                "retry {retries_done} on error {code}"
            );
        }
        assert!(
            !hoai_common::state_retry_allowed(Some(code), 5),
            "no sixth retry on error {code}"
        );
    }
    assert!(
        !hoai_common::state_retry_allowed(Some(2), 0),
        "other errors are final"
    );
    assert!(
        !hoai_common::state_retry_allowed(None, 0),
        "no code is final"
    );
}

#[test]
fn failure_count_resets_only_after_healthy_uptime() {
    assert_eq!(next_failure_count(0, 0), 1, "first failure counts");
    assert_eq!(next_failure_count(3, 599), 4, "short run keeps counting");
    assert_eq!(next_failure_count(u32::MAX, 0), u32::MAX, "never wraps");
    assert_eq!(next_failure_count(8, 600), 1, "600 s up resets the count");
    assert_eq!(
        next_failure_count(u32::MAX, u64::MAX),
        1,
        "any long run resets"
    );
}

#[test]
fn environment_entry_decoding_skips_only_bad_entries() {
    use hoai_common::win32::decode_environment_entry as decode;
    let units = |text: &str| text.encode_utf16().collect::<Vec<u16>>();
    assert_eq!(
        decode(&units("NAME=value=more")),
        Some(("NAME".to_owned(), "value=more".to_owned())),
        "first separator splits"
    );
    assert_eq!(
        decode(&units("=E:=E:\\previous")),
        Some(("=E:".to_owned(), "E:\\previous".to_owned())),
        "per-drive entry keeps its leading character"
    );
    assert_eq!(
        decode(&units("EMPTY=")),
        Some(("EMPTY".to_owned(), String::new()))
    );
    assert_eq!(
        decode(&units("NOSEPARATOR")),
        None,
        "no separator is skipped"
    );
    assert_eq!(
        decode(&[0x41, 0x3D, 0xD800]),
        None,
        "lone surrogate is skipped"
    );
}

#[test]
fn launch_flags_are_windowless_before_spawn() {
    let config = example_config();
    let input = vec![
        ("z".into(), "last".into()),
        ("=E:".into(), "E:\\previous".into()),
        ("USERPROFILE".into(), "E:\\decoy".into()),
        ("node_options".into(), "--no-warnings".into()),
        ("NODE_OPTIONS".into(), "--no-warnings".into()),
        ("hoai_service_namespace".into(), "stray".into()),
        ("a".into(), "first".into()),
    ];
    let plan = build_launch_plan(&config, &input);
    assert_eq!(plan.flags, 0x08000400);
    assert_eq!(plan.flags & 0x00000010, 0);
    assert_eq!(plan.flags & 0x00000008, 0);
    assert!(!plan.inherit_handles);
    assert_eq!(plan.application, config.node_path);
    assert_eq!(
        plan.command_line,
        "\"E:\\node folder\\node.exe\" \"E:\\watcher folder\\bin\\hoai-watcher.mjs\" run"
    );
    assert_eq!(plan.current_directory, config.watcher_dir);
    assert_eq!(
        plan.environment,
        vec![
            ("=E:".into(), "E:\\previous".into()),
            ("a".into(), "first".into()),
            ("HOAI_SERVICE_NAMESPACE".into(), "glass1".into()),
            ("USERPROFILE".into(), config.home.clone()),
            ("z".into(), "last".into()),
        ]
    );
    let mut no_namespace = config;
    no_namespace.namespace = None;
    let plan = build_launch_plan(&no_namespace, &input);
    assert!(!plan
        .environment
        .iter()
        .any(|(name, _)| name.eq_ignore_ascii_case("HOAI_SERVICE_NAMESPACE")));
}

#[test]
fn environment_block_keeps_drive_entries_and_double_terminator() {
    let block = environment_block(&[
        ("=E:".into(), "E:\\scratch".into()),
        ("ALPHA".into(), "unicode-é".into()),
    ]);
    assert_eq!(
        block,
        "=E:=E:\\scratch\0ALPHA=unicode-é\0\0"
            .encode_utf16()
            .collect::<Vec<_>>()
    );
    assert_eq!(environment_block(&[]), vec![0, 0]);
}

#[test]
fn full_path_is_lexical_and_absolute() {
    let result = hoai_common::win32::full_path("E:\\scratch\\sub\\..\\config.json");
    assert!(result.is_ok());
    assert_eq!(result.unwrap(), "E:\\scratch\\config.json");
}

#[test]
fn json_root_must_be_an_object() {
    let runs = std::env::temp_dir().join("hoai-helper-tests").join("runs");
    fs::create_dir_all(&runs).unwrap();
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let folder = runs.join(format!("json-root-{}-{stamp}", std::process::id()));
    fs::create_dir(&folder).unwrap();
    let config = example_config();
    let full = json!([
        config.schema,
        config.home,
        config.node_path,
        config.watcher_dir,
        config.namespace,
        folder.to_str().unwrap(),
        config.test_run_key
    ]);
    let partial = json!([folder.to_str().unwrap()]);
    let actual = (
        parse_config(&serde_json::to_vec(&full).unwrap()).is_ok(),
        config_log_directory(&serde_json::to_vec(&partial).unwrap()),
    );
    fs::remove_dir(&folder).unwrap();
    assert_eq!(actual, (false, None));
}
