#![cfg(windows)]

// These tests start the helper with no testRunKey to prove the refusal. Built with
// this feature that same run would write the real Run key, so they never build with it.
#[cfg(feature = "real-run-key")]
compile_error!("the acceptance tests must never be built with feature real-run-key");

mod support;

#[path = "../src/logging.rs"]
mod product_logging;

use serde_json::Value;
use std::collections::BTreeSet;
use std::fs;
use std::mem::size_of;
use std::thread::sleep;
use std::time::{Duration, Instant};
use support::{
    current_user_sid, harness_in_job, named_mutex_exists, query_process_identity, real_profiles,
    refused_record_identity, registry_key_exists, registry_value_exists, validate_launch_config,
    Desktop, FileHold, Fixture, FocusMonitor, Job, LaunchSafety, Process, RegistryKey, Run,
};
use windows_sys::Win32::System::Threading::{GetProcessMitigationPolicy, ProcessImageLoadPolicy};

#[test]
fn a_harness_refuses_real_home_and_agent_paths() {
    println!(
        "HARNESS_BASELINE in_job={}",
        harness_in_job().expect("own job query succeeds")
    );
    let profiles = real_profiles().expect("both profile sources are readable");
    let case = format!("{}\\runs\\safety-case", support::scratch());
    let valid = LaunchSafety {
        home: format!("{case}\\home"),
        node_path: support::node_image().to_owned(),
        watcher_dir: format!("{case}\\fake-watcher"),
        state_dir: format!("{case}\\state"),
        fixture_root: case,
    };
    assert!(
        validate_launch_config(&valid, &profiles).is_ok(),
        "safe scratch fixture must be admitted"
    );
    for profile in profiles {
        let mut config = valid.clone();
        config.home = profile.clone();
        assert!(
            validate_launch_config(&config, std::slice::from_ref(&profile)).is_err(),
            "real profile home must be refused"
        );
        config.home = format!("{}/", profile.to_uppercase().replace('\\', "/"));
        assert!(
            validate_launch_config(&config, std::slice::from_ref(&profile)).is_err(),
            "real profile aliases must be refused"
        );
        for field in 0..4 {
            let mut config = valid.clone();
            let forbidden = format!("{}\\.bgos-agent\\private", profile.trim_end_matches('\\'));
            match field {
                0 => config.home = forbidden,
                1 => config.node_path = forbidden,
                2 => config.watcher_dir = forbidden,
                _ => config.state_dir = forbidden,
            }
            assert!(
                validate_launch_config(&config, std::slice::from_ref(&profile)).is_err(),
                "real agent path in field {field} must be refused"
            );
        }
    }
}

fn pid(value: &Value) -> u32 {
    value["pid"].as_u64().expect("fake pid") as u32
}

fn observed(run: &mut Run<'_>, count: usize) -> Vec<Value> {
    let result = run.wait_observations(count);
    assert!(
        result.is_ok(),
        "helper must produce {count} fake report(s): {}",
        result.as_ref().err().map_or("", String::as_str)
    );
    result.unwrap()
}

fn published_state(run: &mut Run<'_>, predicate: impl Fn(&Value) -> bool) -> Value {
    let result = run.wait_state(predicate);
    assert!(
        result.is_ok(),
        "helper must publish required state: {}",
        result.as_ref().err().map_or("", String::as_str)
    );
    result.unwrap()
}

fn assert_state_identity(state: &Value) {
    assert_eq!(state["schema"], 1, "state schema");
    assert!(
        state["helperPid"].as_u64().is_some_and(|pid| pid > 0),
        "helper pid recorded"
    );
    assert!(
        state["helperCreationTime"]
            .as_str()
            .and_then(|time| time.parse::<u64>().ok())
            .is_some_and(|time| time > 0),
        "helper creation recorded"
    );
    assert!(
        state["watcherPid"].as_u64().is_some(),
        "watcher pid is an integer"
    );
    assert!(
        state["watcherCreationTime"]
            .as_str()
            .and_then(|time| time.parse::<u64>().ok())
            .is_some(),
        "watcher creation is decimal ticks"
    );
    assert!(
        state["restartCount"].as_u64().is_some(),
        "restart count is an integer"
    );
    assert!(
        state["lastErrorCode"].as_u64().is_some(),
        "error code is numeric"
    );
    assert_eq!(
        state["inJob"], "breakaway refused",
        "test helper stays in refusing harness job"
    );
    assert!(
        state["inJobErrorCode"]
            .as_u64()
            .is_some_and(|code| code > 0),
        "breakaway failure recorded"
    );
}

fn assert_fake_contract(fixture: &Fixture, observation: &Value, namespace: Option<&str>) {
    assert_eq!(
        observation["args"][0],
        fixture.script().to_string_lossy().as_ref(),
        "watcher argv[1]"
    );
    assert_eq!(observation["args"][1], "run", "watcher argv[2]");
    assert_eq!(
        observation["args"].as_array().expect("argv array").len(),
        2,
        "only documented watcher arguments"
    );
    assert_eq!(
        observation["cwd"],
        fixture.watcher.to_string_lossy().as_ref(),
        "watcher working folder"
    );
    assert_eq!(
        observation["home"],
        fixture.home.to_string_lossy().as_ref(),
        "watcher uses configured home"
    );
    assert_eq!(
        observation["nodeOptionsPresent"], false,
        "no option-loading environment value"
    );
    assert_eq!(
        observation["namespace"].as_str(),
        namespace,
        "namespace derives only from config"
    );
}

#[test]
fn a_harness_refuses_config_edited_to_a_real_home() {
    // Validation only: this test never starts anything.
    let mut fixture = Fixture::new("edited-home").expect("scratch fixture");
    let config = fixture.config_path.clone();
    assert!(
        fixture.validate_before_launch(&config).is_ok(),
        "the scratch config is admitted"
    );
    let profile = real_profiles().expect("profiles").remove(0);
    fixture.config["home"] = Value::String(profile);
    fixture.save_config().expect("write edited config");
    assert!(
        fixture.validate_before_launch(&config).is_err(),
        "a config edited to the real home is refused before any launch"
    );
}

/// Whole-token match, so code=5 never matches code=50 and a time field never matches.
fn log_has_code(log: &str, code: u32) -> bool {
    let wanted = format!("code={code}");
    log.split_whitespace().any(|field| field == wanted)
}

/// Longer than the fake watcher needs to report, so a late start cannot pass as no start.
const NO_CHILD_SETTLE: Duration = Duration::from_secs(2);

#[test]
fn image_load_policy_readback() {
    let fixture = Fixture::new("policy").expect("scratch fixture");
    let mut run = fixture
        .launch("run", &[], false)
        .expect("safe helper launch");
    observed(&mut run, 1);
    let mut bits = 0_u32;
    assert_ne!(
        unsafe {
            GetProcessMitigationPolicy(
                run.helper.handle,
                ProcessImageLoadPolicy,
                (&mut bits as *mut u32).cast(),
                size_of::<u32>(),
            )
        },
        0,
        "read helper image policy"
    );
    println!("IMAGE_LOAD_POLICY flags={bits:#x}");
    assert_eq!(
        bits & 7,
        7,
        "remote images, low-label images and preferred system loading configured"
    );
}

#[test]
fn bad_config_exits_10_without_child() {
    for (label, field, value) in [
        ("schema", "schema", Value::from(2)),
        (
            "unknown",
            "unknownField",
            Value::from("UNLOGGED_CONFIG_CONTENT"),
        ),
        ("namespace", "namespace", Value::from("INVALID")),
        ("namespace-null", "namespace", Value::Null),
        ("key-null", "testRunKey", Value::Null),
    ] {
        let mut fixture = Fixture::new(label).expect("scratch fixture");
        fixture.config[field] = value;
        fixture.save_config().expect("write invalid config");
        let run = fixture
            .launch("run", &[], false)
            .expect("safe invalid-config launch");
        assert_eq!(
            run.helper
                .exit_code(Duration::from_secs(30))
                .expect("helper exits"),
            10,
            "invalid {label} exit code"
        );
        let log = fixture.log();
        assert_eq!(log.lines().count(), 1, "one invalid-config log line");
        assert!(
            !log.contains("UNLOGGED_CONFIG_CONTENT"),
            "config content never logged"
        );
        assert!(
            !fixture.state_path().exists(),
            "bad config never writes state"
        );
        sleep(NO_CHILD_SETTLE);
        assert_eq!(
            fs::read_dir(fixture.watcher.join("bin"))
                .unwrap()
                .filter_map(Result::ok)
                .filter(|file| file.file_name().to_string_lossy().starts_with("observed-"))
                .count(),
            0,
            "bad config starts nothing"
        );
    }
}

#[test]
fn unreadable_config_exits_10_without_fallback_log() {
    let fixture = Fixture::new("unreadable-config").expect("scratch fixture");
    fs::write(&fixture.config_path, b"{ invalid JSON").expect("write malformed owned config");
    let run = fixture
        .launch("run", &[], false)
        .expect("safe invalid-config launch");
    assert_eq!(
        run.helper.exit_code(Duration::from_secs(30)).unwrap(),
        10,
        "unreadable config exit"
    );
    assert!(
        !fixture.log_path().exists(),
        "no fallback log when stateDir cannot be read"
    );
    assert!(!fixture.state_path().exists(), "no fallback state");
    let run = fixture
        .launch_without_config("run", &[])
        .expect("safe missing-config launch");
    assert_eq!(
        run.helper.exit_code(Duration::from_secs(30)).unwrap(),
        10,
        "config argument required"
    );
    assert!(
        !fixture.log_path().exists(),
        "missing argument has no fallback log"
    );
}

#[test]
fn missing_required_path_exits_11_without_child() {
    for field in ["nodePath", "watcherDir", "script"] {
        let mut fixture = Fixture::new("missing-path").expect("scratch fixture");
        let missing = match field {
            "nodePath" => fixture.root.join("missing-node.exe"),
            "watcherDir" => fixture.root.join("missing-watcher"),
            _ => fixture.script(),
        };
        if field == "script" {
            fs::remove_file(&missing).expect("remove own fake script");
        } else {
            fixture.config[field] = Value::String(missing.to_string_lossy().into_owned());
            fixture.save_config().unwrap();
        }
        let run = fixture
            .launch("run", &[], false)
            .expect("safe missing-path launch");
        assert_eq!(
            run.helper.exit_code(Duration::from_secs(30)).unwrap(),
            11,
            "first missing {field} exit"
        );
        let state = fixture
            .read_state()
            .expect("missing path recorded in state");
        assert_eq!(
            state["lastErrorPath"],
            missing.to_string_lossy().as_ref(),
            "specific missing path recorded"
        );
        assert!(
            state["lastErrorCode"].as_u64().is_some_and(|code| code > 0),
            "native failure code recorded"
        );
        assert_eq!(state["watcherPid"], 0, "nothing started");
    }
}

#[test]
fn fake_watcher_launch_contract() {
    let fixture = Fixture::new("launch-contract").expect("scratch fixture");
    let mut run = fixture
        .launch(
            "run",
            &[
                ("NODE_OPTIONS", "--no-warnings"),
                ("HOAI_SERVICE_NAMESPACE", "stray"),
            ],
            false,
        )
        .expect("safe helper launch");
    let observations = observed(&mut run, 1);
    let observation = &observations[0];
    println!("FAKE_CONTRACT {}", observation);
    assert_fake_contract(&fixture, observation, Some("gh"));
    assert_eq!(
        observation["stdoutIsTTY"], true,
        "B5 requires a console-backed stdout"
    );
    assert!(
        run.process(pid(observation))
            .in_this_job(run.job.as_ref().expect("the run holds its job"))
            .expect("fake job query"),
        "watcher is inside harness-owned job"
    );
}

#[test]
fn absent_namespace_removes_inherited_value() {
    let mut fixture = Fixture::new("namespace-absent").expect("scratch fixture");
    fixture.config.as_object_mut().unwrap().remove("namespace");
    fixture.save_config().unwrap();
    let mut run = fixture
        .launch("run", &[("hoai_service_namespace", "stray")], false)
        .expect("safe helper launch");
    let observations = observed(&mut run, 1);
    assert_fake_contract(&fixture, &observations[0], None);
}

#[test]
fn fake_watcher_observes_scratch_home() {
    let fixture = Fixture::new("home").expect("scratch fixture");
    let mut run = fixture
        .launch("run", &[], false)
        .expect("safe helper launch");
    let observations = observed(&mut run, 1);
    println!("FAKE_HOME {}", observations[0]["home"]);
    assert_eq!(
        observations[0]["home"],
        fixture.home.to_string_lossy().as_ref(),
        "raw configured USERPROFILE reaches node"
    );
    assert_ne!(
        observations[0]["home"],
        fixture.decoy.to_string_lossy().as_ref(),
        "inherited decoy is replaced"
    );
}

#[test]
fn fake_watcher_has_no_node_options() {
    for key in ["NODE_OPTIONS", "node_options"] {
        let fixture = Fixture::new("options").expect("scratch fixture");
        let mut run = fixture
            .launch("run", &[(key, "--no-warnings")], false)
            .expect("safe helper launch");
        let observations = observed(&mut run, 1);
        println!(
            "FAKE_OPTIONS inputCase={key} present={}",
            observations[0]["nodeOptionsPresent"]
        );
        assert_eq!(
            observations[0]["nodeOptionsPresent"], false,
            "all case variants removed"
        );
    }
}

#[test]
fn fake_watcher_has_no_lowercase_node_options() {
    let fixture = Fixture::new("lowercase-options").expect("scratch fixture");
    let mut run = fixture
        .launch("run", &[("node_options", "--no-warnings")], false)
        .expect("safe helper launch");
    let observations = observed(&mut run, 1);
    println!(
        "FAKE_OPTIONS inputCase=node_options present={}",
        observations[0]["nodeOptionsPresent"]
    );
    assert_eq!(
        observations[0]["nodeOptionsPresent"], false,
        "lowercase option-loading value is removed"
    );
}

#[test]
fn first_two_restarts_are_observed() {
    let fixture = Fixture::new("backoff").expect("scratch fixture");
    fixture.set_mode("ack-exit").unwrap();
    let mut run = fixture
        .launch("run", &[], false)
        .expect("safe helper launch");
    let first = observed(&mut run, 1);
    let first_pid = pid(&first[0]);
    run.acknowledge(first_pid).unwrap();
    assert_eq!(
        run.process(first_pid)
            .exit_code(Duration::from_secs(30))
            .unwrap(),
        0
    );
    let second = observed(&mut run, 2);
    let second_pid = pid(&second[1]);
    run.acknowledge(second_pid).unwrap();
    assert_eq!(
        run.process(second_pid)
            .exit_code(Duration::from_secs(30))
            .unwrap(),
        0
    );
    let third = observed(&mut run, 3);
    let third_pid = pid(&third[2]);
    let wait_one = (run.process(second_pid).creation - run.process(first_pid).times().unwrap().1)
        as f64
        / 10_000_000.0;
    let wait_two = (run.process(third_pid).creation - run.process(second_pid).times().unwrap().1)
        as f64
        / 10_000_000.0;
    println!("RESTART_WAITS firstSeconds={wait_one:.6} secondSeconds={wait_two:.6}");
    assert!((0.95..=2.0).contains(&wait_one), "first restart wait");
    assert!((1.95..=4.0).contains(&wait_two), "second restart wait");
    assert!(wait_two > wait_one + 0.5, "second restart waits longer");
}

#[test]
fn same_config_second_instance_exits_12() {
    let fixture = Fixture::new("single-instance").expect("scratch fixture");
    let mut first = fixture
        .launch("run", &[], false)
        .expect("first safe launch");
    let observations = observed(&mut first, 1);
    let name = hoai_common::mutex_name(
        &current_user_sid().expect("own SID"),
        &fixture.config_path.to_string_lossy(),
    )
    .expect("expected mutex name");
    assert!(
        named_mutex_exists(&name),
        "the live mutex is named for this user and this config"
    );
    let before = fs::read(fixture.state_path()).unwrap();
    let second = fixture
        .launch_config_alias("run", &fixture.root.join(".").join("config.json"))
        .expect("second safe launch");
    assert_eq!(
        second.helper.exit_code(Duration::from_secs(30)).unwrap(),
        12,
        "same full configuration is already running"
    );
    sleep(NO_CHILD_SETTLE);
    assert_eq!(
        first.observations().unwrap().len(),
        observations.len(),
        "no second watcher"
    );
    assert_eq!(
        fs::read(fixture.state_path()).unwrap(),
        before,
        "duplicate does not write state"
    );
    assert!(
        first.helper.running(),
        "first helper survives second instance"
    );
}

#[test]
fn different_configs_can_run_independently() {
    let one = Fixture::new("independent-one").expect("scratch fixture");
    let two = Fixture::new("independent-two").expect("scratch fixture");
    let mut first = one.launch("run", &[], false).expect("first safe launch");
    let mut second = two.launch("run", &[], false).expect("second safe launch");
    let first_pid = pid(&observed(&mut first, 1)[0]);
    let second_pid = pid(&observed(&mut second, 1)[0]);
    assert_ne!(first_pid, second_pid);
    assert!(
        first.helper.running() && second.helper.running(),
        "different config mutexes coexist"
    );
}

#[test]
fn register_roundtrip_touches_only_own_value() {
    let fixture = Fixture::new("registry-roundtrip").expect("scratch fixture");
    let key = RegistryKey::create(&fixture.key(), false).expect("owned test registry key");
    key.set("unrelated-sentinel", "keep").unwrap();
    let run = fixture
        .launch("register", &[], false)
        .expect("safe registration launch");
    assert_eq!(
        run.helper.exit_code(Duration::from_secs(30)).unwrap(),
        0,
        "registration succeeds"
    );
    let values = key.values().unwrap();
    let name = hoai_common::helper_value_name(&fixture.home.to_string_lossy(), Some("gh"))
        .expect("helper name");
    let config_path = support::full_path(&fixture.config_path.to_string_lossy()).unwrap();
    assert_eq!(
        values.get(&name),
        Some(&format!(
            "\"{}\" run --config \"{config_path}\"",
            fixture.binary.display()
        )),
        "exact REG_SZ command"
    );
    assert_eq!(values.len(), 2, "only helper and sentinel values");
    let run = fixture
        .launch("unregister", &[], false)
        .expect("safe unregister launch");
    assert_eq!(
        run.helper.exit_code(Duration::from_secs(30)).unwrap(),
        0,
        "unregister succeeds"
    );
    let values = key.values().unwrap();
    assert_eq!(values.len(), 1);
    assert_eq!(
        values.get("unrelated-sentinel").map(String::as_str),
        Some("keep")
    );
    assert!(
        !fixture.state_path().exists(),
        "registry CLI does not supervise"
    );
}

#[test]
fn register_without_test_key_exits_14_without_registry_access() {
    let mut fixture = Fixture::new("registry-default-refusal").expect("scratch fixture");
    fixture.config.as_object_mut().unwrap().remove("testRunKey");
    fixture.save_config().unwrap();
    for verb in ["register", "unregister"] {
        let run = fixture
            .launch(verb, &[], false)
            .expect("safe default-key refusal launch");
        assert_eq!(
            run.helper.exit_code(Duration::from_secs(30)).unwrap(),
            14,
            "feature-disabled real key is refused"
        );
    }
    assert!(
        !fixture.state_path().exists(),
        "no process starts from registry CLI"
    );
}

#[test]
fn test_key_prefix_is_enforced_before_registry_open() {
    let mut fixture = Fixture::new("registry-invalid").expect("scratch fixture");
    let root_key = fixture.create_registry_parent(false).unwrap();
    root_key.set("unrelated-sentinel", "keep").unwrap();
    // The read back has to see what exists, or the checks below would prove nothing.
    assert!(
        registry_key_exists(&fixture.key_parent),
        "read back sees a key that exists"
    );
    assert!(
        registry_value_exists(&fixture.key_parent, "unrelated-sentinel"),
        "read back sees a value that exists"
    );
    let name = hoai_common::helper_value_name(&fixture.home.to_string_lossy(), Some("gh"))
        .expect("helper value name");
    // The harmless foreign key goes first: a product that stopped refusing fails there,
    // long before it could reach the RunOnce shape at the end of this list.
    let foreign = "Software\\HOAI-Tested\\glasshelper";
    for key in [
        foreign.to_owned(),
        "Software\\HOAI-Test".to_owned(),
        format!("{}\\\\Run", fixture.key_parent),
        format!("{}\\Run\\", fixture.key_parent),
        "Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce".to_owned(),
    ] {
        fixture.config["testRunKey"] = Value::String(key.clone());
        fixture.save_config().unwrap();
        for verb in ["register", "unregister"] {
            let run = fixture
                .launch(verb, &[], false)
                .expect("safe invalid-key launch");
            assert_eq!(
                run.helper.exit_code(Duration::from_secs(30)).unwrap(),
                14,
                "invalid own-subtree shape refused"
            );
        }
        assert!(
            !registry_key_exists(foreign),
            "a key outside the test prefix is never created"
        );
        assert!(
            !registry_value_exists(&key, &name),
            "a refused key shape gets no helper value"
        );
        let values = root_key.values().unwrap();
        assert_eq!(values.len(), 1);
        assert_eq!(
            values.get("unrelated-sentinel").map(String::as_str),
            Some("keep")
        );
    }
    assert!(
        RegistryKey::open(&fixture.key()).is_err(),
        "invalid key never creates Run child"
    );
}

#[test]
fn registry_failure_exits_13() {
    let fixture = Fixture::new("registry-volatile").expect("scratch fixture");
    let _parent = fixture
        .create_registry_parent(true)
        .expect("owned volatile parent");
    let run = fixture
        .launch("register", &[], false)
        .expect("safe registration failure launch");
    assert_eq!(
        run.helper.exit_code(Duration::from_secs(30)).unwrap(),
        13,
        "stable child of volatile parent is refused"
    );
    assert!(
        log_has_code(&fixture.log(), 1021),
        "native registry error recorded"
    );
}

#[test]
fn generic_failure_exits_1_with_windows_code() {
    let fixture = Fixture::new("state-directory-conflict").expect("scratch fixture");
    fs::create_dir(fixture.state_path()).unwrap();
    let run = fixture
        .launch("run", &[], false)
        .expect("safe state-write failure launch");
    assert_eq!(
        run.helper.exit_code(Duration::from_secs(30)).unwrap(),
        1,
        "state write failure is generic failure"
    );
    let log = fixture.log();
    let state_path = fixture.state_path().to_string_lossy().into_owned();
    assert!(
        log.lines().any(|line| line.contains(&state_path)
            && line.split_once("code=").is_some_and(|(_, suffix)| suffix
                .chars()
                .take_while(char::is_ascii_digit)
                .collect::<String>()
                .parse::<u32>()
                .is_ok_and(|code| code > 0))),
        "native state-write code recorded with its path: {log}"
    );
    assert!(
        fixture.state_path().is_dir(),
        "conflicting owned directory not replaced"
    );
}

#[test]
fn deny_breakaway_records_and_stays() {
    let fixture = Fixture::new("job-deny").expect("scratch fixture");
    let mut run = fixture
        .launch("run", &[], false)
        .expect("safe refusing-job launch");
    let observations = observed(&mut run, 1);
    let state = published_state(&mut run, |state| {
        state["watcherPid"].as_u64().is_some_and(|pid| pid > 0)
    });
    assert_state_identity(&state);
    let job = run.job.as_ref().expect("the run holds its job");
    assert!(
        run.helper.running() && run.helper.in_this_job(job).unwrap(),
        "original helper remains in refusing job"
    );
    assert!(
        run.process(pid(&observations[0])).in_this_job(job).unwrap(),
        "fake stays in harness job"
    );
}

#[test]
fn job_membership_reads_the_job_named() {
    let fixture = Fixture::new("job-named").expect("scratch fixture");
    let mut run = fixture
        .launch("run", &[], false)
        .expect("safe refusing-job launch");
    let observations = observed(&mut run, 1);
    let own = run.job.as_ref().expect("the run holds its job");
    let other = Job::new(false).expect("a job nothing joined");
    let fake = run.process(pid(&observations[0]));
    for (process, name) in [(&run.helper, "helper"), (fake, "fake")] {
        assert!(process.in_this_job(own).unwrap(), "{name} is in its job");
        assert!(
            !process.in_this_job(&other).unwrap(),
            "{name} is not in a job it never joined"
        );
    }
}

#[test]
fn an_exited_process_still_held_open_reads_as_gone() {
    let mut fixture = Fixture::new("exited-record").expect("scratch fixture");
    fixture.config.as_object_mut().unwrap().remove("testRunKey");
    fixture.save_config().unwrap();
    let run = fixture
        .launch("register", &[], false)
        .expect("safe default-key refusal launch");
    assert_eq!(
        run.helper.exit_code(Duration::from_secs(30)).unwrap(),
        14,
        "the helper ended by itself"
    );
    assert_eq!(
        query_process_identity(run.helper.pid),
        Ok(None),
        "an exited process this test still holds open is no leftover"
    );
}

#[test]
fn a_refused_record_is_not_ours_unless_it_may_be_a_fake() {
    assert_eq!(
        refused_record_identity(4, Some("System")),
        Ok(None),
        "a reused pid under another program's name is not this lane's"
    );
    assert_eq!(
        refused_record_identity(4, None),
        Ok(None),
        "a pid gone from the process list is gone"
    );
    for name in ["node.exe", "NODE.EXE", "hoai-helper.exe", "HOAI-Helper.EXE"] {
        assert!(
            refused_record_identity(4, Some(name)).is_err(),
            "{name} can be this lane's, so a refusal stays a failure"
        );
    }
}

#[test]
fn allow_breakaway_survives_job_close() {
    let fixture = Fixture::new("job-allow").expect("scratch fixture");
    let mut run = fixture
        .launch("run", &[], true)
        .expect("safe allowing-job launch");
    let sentinel = run.sentinel().expect("owned control sentinel");
    assert_eq!(
        run.helper.exit_code(Duration::from_secs(30)).unwrap(),
        0,
        "original handed over"
    );
    let started = Instant::now();
    let state = loop {
        if let Some(state) = fixture.read_state() {
            if state["watcherPid"].as_u64().is_some_and(|pid| pid > 0) {
                break state;
            }
        }
        assert!(
            started.elapsed() < Duration::from_secs(30),
            "relaunched helper reaches state"
        );
        sleep(Duration::from_millis(2));
    };
    let helper_pid = state["helperPid"].as_u64().unwrap() as u32;
    let helper_time = state["helperCreationTime"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    let adoption = run.adopt_state(&state);
    assert!(
        adoption.is_ok(),
        "retain escaped state identities: {:?}",
        adoption.err()
    );
    let helper = Process::open(helper_pid, Some(helper_time), &fixture.binary)
        .expect("retain relaunched helper");
    let observations = observed(&mut run, 1);
    assert_eq!(observations.len(), 1, "one escaped fake");
    assert_eq!(state["inJob"], "not in job");
    run.job.take();
    sentinel
        .exit_code(Duration::from_secs(5))
        .expect("job sentinel dies when job closes");
    assert!(!sentinel.running(), "job close control works");
    assert!(
        helper.running() && run.process(pid(&observations[0])).running(),
        "escaped helper and watcher survive job close"
    );
    assert!(
        !helper.in_job().unwrap() && !run.process(pid(&observations[0])).in_job().unwrap(),
        "escaped processes are outside jobs"
    );
}

#[test]
fn state_is_complete_atomic_and_pid_time_scoped() {
    let fixture = Fixture::new("atomic-state").expect("scratch fixture");
    fixture.set_mode("ack-exit").unwrap();
    let mut run = fixture
        .launch("run", &[], false)
        .expect("safe helper launch");
    let mut observations = observed(&mut run, 1);
    let mut previous = pid(&observations[0]);
    let mut reads = 0_usize;
    for next_count in 2..=4 {
        run.acknowledge(previous).unwrap();
        let started = Instant::now();
        loop {
            let bytes = fs::read(fixture.state_path()).expect("published state never disappears");
            let state: Value =
                serde_json::from_slice(&bytes).expect("published state is always whole JSON");
            assert_state_identity(&state);
            reads += 1;
            observations = run.observations().expect("read fake observations");
            if observations.len() >= next_count {
                break;
            }
            assert!(run.helper.running(), "helper stays alive through restart");
            assert!(
                started.elapsed() < Duration::from_secs(30),
                "restart readiness deadline"
            );
            sleep(Duration::from_millis(2));
        }
        previous = pid(&observations[next_count - 1]);
    }
    let state = published_state(&mut run, |state| {
        state["watcherPid"].as_u64() == Some(u64::from(previous))
    });
    assert_eq!(state["helperPid"], run.helper.pid);
    assert_eq!(state["helperCreationTime"], run.helper.creation.to_string());
    assert_eq!(state["watcherPid"], previous);
    assert_eq!(
        state["watcherCreationTime"],
        run.process(previous).creation.to_string()
    );
    assert!(state["restartCount"].as_u64().unwrap() >= 3);
    assert!(reads >= 20, "concurrent reader actually sampled repeatedly");
    println!(
        "ATOMIC_STATE reads={reads} generations={}",
        observations.len()
    );
}

#[test]
fn supervision_rechecks_missing_paths_and_recovers() {
    let fixture = Fixture::new("supervision-paths").expect("scratch fixture");
    let script = fs::read(fixture.script()).unwrap();
    let mut run = fixture
        .launch("run", &[], false)
        .expect("safe helper launch");
    let first = observed(&mut run, 1);
    fs::remove_file(fixture.script()).expect("remove own fake script");
    run.process(pid(&first[0])).end().unwrap();
    let state = published_state(&mut run, |state| {
        state["lastErrorPath"].as_str() == Some(fixture.script().to_string_lossy().as_ref())
    });
    assert!(state["lastErrorCode"].as_u64().is_some_and(|code| code > 0));
    assert!(
        run.helper.running(),
        "supervision path failure does not exit 11"
    );
    fs::write(fixture.script(), script).unwrap();
    assert_eq!(observed(&mut run, 2).len(), 2);
}

#[test]
fn log_lines_hold_codes_paths_and_times_only() {
    let fixture = Fixture::new("log-shape").expect("scratch fixture");
    let mut run = fixture
        .launch("run", &[], false)
        .expect("safe helper launch");
    observed(&mut run, 1);
    drop(run);
    let log = fs::read_to_string(fixture.log_path()).unwrap();
    assert!(log.contains("code="), "the run wrote log lines");
    for line in log.lines() {
        let rest = line
            .strip_prefix("time=")
            .unwrap_or_else(|| panic!("line opens with its time: {line}"));
        let (time, rest) = rest
            .split_once(" code=")
            .unwrap_or_else(|| panic!("line has a code: {line}"));
        assert!(time.parse::<u128>().is_ok(), "time is a number: {line}");
        let (code, path) = rest
            .split_once(" path=")
            .map_or((rest, None), |(code, path)| (code, Some(path)));
        assert!(code.parse::<u32>().is_ok(), "code is a number: {line}");
        if let Some(path) = path {
            assert!(
                std::path::Path::new(path).exists(),
                "only a real path follows path=: {line}"
            );
        }
    }
}

#[test]
fn log_caps_rolls_once_and_excludes_payloads() {
    let fixture = Fixture::new("log-rotation").expect("scratch fixture");
    let limit = 1024 * 1024;
    let filler = "0 code=0 time=0\n".repeat((limit - 16) / 16);
    fs::write(fixture.log_path(), &filler).unwrap();
    let mut run = fixture
        .launch(
            "run",
            &[("HOAI_SYNTHETIC_SECRET", "UNLOGGED_ENV_VALUE")],
            false,
        )
        .expect("safe helper launch");
    observed(&mut run, 1);
    let rolled = fixture.state.join("helper.log.1");
    assert!(rolled.is_file(), "log rolls at cap");
    for path in [fixture.log_path(), rolled.clone()] {
        let data = fs::read(&path).unwrap();
        assert!(data.len() <= limit, "log file capped");
        assert!(
            !String::from_utf8_lossy(&data).contains("UNLOGGED_ENV_VALUE"),
            "environment contents absent"
        );
    }
    assert!(
        !fixture.state.join("helper.log.2").exists(),
        "only one rollover retained"
    );
    drop(run);
    let second = "1 code=0 time=1\n".repeat((limit - 16) / 16);
    fs::write(fixture.log_path(), &second).unwrap();
    let mut run = fixture
        .launch("run", &[], false)
        .expect("second safe launch");
    observed(&mut run, 1);
    assert_eq!(
        fs::read_to_string(rolled).unwrap(),
        second,
        "second rollover replaces the first"
    );
}

#[test]
fn ten_seconds_no_visible_window_or_focus_change() {
    for attempt in 0..3 {
        let fixture = Fixture::new("focus").expect("scratch fixture");
        let monitor = FocusMonitor::start().expect("desktop baseline");
        let mut run = fixture
            .launch("run", &[], false)
            .expect("safe helper launch");
        monitor.add(run.helper.pid);
        let observations = observed(&mut run, 1);
        monitor.add(pid(&observations[0]));
        monitor.mark_ready();
        sleep(Duration::from_secs(10));
        assert!(
            run.helper.running() && run.process(pid(&observations[0])).running(),
            "both processes alive throughout observation"
        );
        match monitor.finish() {
            Ok(()) => return,
            Err(problem) if problem.starts_with("INCONCLUSIVE:") && attempt < 2 => {
                println!("FOCUS_RETRY attempt={} {problem}", attempt + 1)
            }
            Err(problem) => panic!("{problem}"),
        }
    }
    unreachable!();
}

#[test]
fn desktop_check_goes_red_without_opening_a_window() {
    let desktop = Desktop::capture().expect("desktop reading");
    let owners = desktop.window_owners();
    let owned = desktop
        .check(&owners)
        .expect_err("a visible window owned by a listed process fails");
    assert!(
        owned.starts_with("FAIL: owned visible window hwnd="),
        "{owned}"
    );
    let moved = desktop
        .with_false_foreground()
        .check(&BTreeSet::new())
        .expect_err("a foreground other than the baseline fails");
    assert!(
        moved.starts_with("FAIL: foreground changed hwnd="),
        "the report names what took the foreground: {moved}"
    );
}

#[test]
fn failure_cleanup_leaves_no_owned_process() {
    let fixture = Fixture::new("cleanup").expect("scratch fixture");
    let mut run = fixture
        .launch("run", &[], false)
        .expect("safe helper launch");
    let observations = observed(&mut run, 1);
    let helper = Process::open(run.helper.pid, Some(run.helper.creation), &fixture.binary)
        .expect("retain helper observer");
    let fake_pid = pid(&observations[0]);
    let fake = Process::open(
        fake_pid,
        Some(run.process(fake_pid).creation),
        std::path::Path::new(support::node_image()),
    )
    .expect("retain fake observer");
    let result: Result<(), &str> = (|| {
        let _guard = run;
        Err("intentional harness failure")
    })();
    assert_eq!(result, Err("intentional harness failure"));
    helper
        .exit_code(Duration::from_secs(5))
        .expect("helper cleaned after failure");
    fake.exit_code(Duration::from_secs(5))
        .expect("fake cleaned after failure");
    assert!(
        !helper.running() && !fake.running(),
        "no owned process remains"
    );
}

#[test]
fn initial_state_replacement_retries_until_share_is_released() {
    let fixture = Fixture::new("state-retry-release").expect("scratch fixture");
    fs::write(fixture.state_path(), b"{\"sentinel\":true}").unwrap();
    let hold = FileHold::deny_replacement(&fixture.state_path()).expect("hold own state file");
    let mut run = fixture
        .launch("run", &[], false)
        .expect("safe helper launch");
    let temporary = fixture
        .state
        .join(format!("helper-state.json.{}.tmp", run.helper.pid));
    let started = Instant::now();
    while !temporary.exists() && run.helper.running() && started.elapsed() < Duration::from_secs(5)
    {
        sleep(Duration::from_millis(2));
    }
    assert!(
        temporary.exists(),
        "helper must attempt initial state before child launch"
    );
    assert!(
        run.observations().unwrap().is_empty(),
        "no fake starts before initial state publication"
    );
    drop(hold);
    let reports = observed(&mut run, 1);
    let state = published_state(&mut run, |state| {
        state["watcherPid"].as_u64() == Some(u64::from(pid(&reports[0])))
    });
    assert_state_identity(&state);
    assert!(
        !temporary.exists(),
        "successful state publication consumes temporary file"
    );
}

#[test]
fn initial_state_retry_exhaustion_exits_1_and_removes_temporary() {
    let fixture = Fixture::new("state-retry-exhaust").expect("scratch fixture");
    fs::write(fixture.state_path(), b"{\"sentinel\":true}").unwrap();
    let _hold = FileHold::deny_replacement(&fixture.state_path()).expect("hold own state file");
    let mut run = fixture
        .launch("run", &[], false)
        .expect("safe helper launch");
    assert_eq!(
        run.helper.exit_code(Duration::from_secs(30)).unwrap(),
        1,
        "exhausted initial publication fails before child launch"
    );
    let log = fixture.log();
    assert!(
        log_has_code(&log, 32) || log_has_code(&log, 5),
        "native sharing failure recorded: {log}"
    );
    assert!(
        log.contains(fixture.state_path().to_string_lossy().as_ref()),
        "failure names state target"
    );
    assert!(
        run.observations().unwrap().is_empty(),
        "no fake starts while publication is impossible"
    );
    assert!(
        !fixture
            .state
            .join(format!("helper-state.json.{}.tmp", run.helper.pid))
            .exists(),
        "failed publication removes own temporary file"
    );
}

#[test]
fn supervision_continues_when_state_replacement_is_held() {
    let fixture = Fixture::new("state-supervision-held").expect("scratch fixture");
    let mut run = fixture
        .launch("run", &[], false)
        .expect("safe helper launch");
    let first = observed(&mut run, 1);
    let hold = FileHold::deny_replacement(&fixture.state_path()).expect("hold published state");
    run.process(pid(&first[0])).end().unwrap();
    let second = observed(&mut run, 2);
    assert!(
        run.helper.running(),
        "state publication failure does not stop supervision"
    );
    let log = fixture.log();
    assert!(
        log_has_code(&log, 32) || log_has_code(&log, 5),
        "supervision logs native sharing error: {log}"
    );
    drop(hold);
    run.process(pid(&second[1])).end().unwrap();
    let third = observed(&mut run, 3);
    let state = published_state(&mut run, |state| {
        state["watcherPid"].as_u64() == Some(u64::from(pid(&third[2])))
    });
    assert_state_identity(&state);
}

#[test]
fn unwritable_log_exits_1_before_any_watcher() {
    let control = Fixture::new("log-write-control").expect("scratch fixture");
    let mut normal = control
        .launch("run", &[], false)
        .expect("safe control launch");
    observed(&mut normal, 1);
    drop(normal);
    let fixture = Fixture::new("log-directory-conflict").expect("scratch fixture");
    fs::create_dir(fixture.log_path()).unwrap();
    let mut run = fixture
        .launch("run", &[], false)
        .expect("safe failed-log launch");
    assert_eq!(
        run.helper.exit_code(Duration::from_secs(30)).unwrap(),
        1,
        "initial log failure exits one"
    );
    assert!(
        run.observations().unwrap().is_empty(),
        "log failure starts no watcher"
    );
    assert!(
        fixture.log_path().is_dir(),
        "existing owned directory is preserved"
    );
}

#[test]
fn log_rotation_is_serialized_across_writers() {
    use std::collections::BTreeMap;
    use std::sync::{Arc, Barrier};

    const WRITERS: usize = 32;
    const ROUNDS: usize = 8;
    let fixture = Fixture::new("log-concurrent-rotation").expect("scratch fixture");
    let mut failures = Vec::new();
    for round in 0..ROUNDS {
        let seed = vec![b'A' + round as u8; product_logging::LOG_LIMIT as usize - 8];
        if let Err(problem) = fs::write(fixture.log_path(), &seed) {
            failures.push(format!(
                "round={round} seedWriteFailed=true code={:?}",
                problem.raw_os_error()
            ));
            continue;
        }
        let barrier = Arc::new(Barrier::new(WRITERS + 1));
        let mut writers = Vec::new();
        for writer in 0..WRITERS {
            let directory = fixture.state.clone();
            let barrier = Arc::clone(&barrier);
            let code = 1_000_000 + (round * WRITERS + writer) as u32;
            writers.push(std::thread::spawn(move || {
                let logger = product_logging::Logger::new(&directory);
                barrier.wait();
                logger.record(code, None, None)
            }));
        }
        barrier.wait();
        let joined = writers
            .into_iter()
            .map(|writer| writer.join())
            .collect::<Vec<_>>();
        let mut panic_count = 0;
        let mut write_errors = 0;
        for result in joined {
            match result {
                Ok(Ok(())) => {}
                Ok(Err(_)) => write_errors += 1,
                Err(_) => panic_count += 1,
            }
        }
        let previous = fs::read(fixture.state.join("helper.log.1"));
        let current = fs::read(fixture.log_path());
        let seed_equal = previous.as_ref().is_ok_and(|bytes| bytes == &seed);
        let previous_len = previous.as_ref().map(Vec::len).unwrap_or(0);
        let current_len = current.as_ref().map(Vec::len).unwrap_or(0);
        let current_text = current
            .as_ref()
            .ok()
            .and_then(|bytes| std::str::from_utf8(bytes).ok());
        let read_errors = usize::from(previous.is_err())
            + usize::from(current.is_err())
            + usize::from(current.is_ok() && current_text.is_none());
        let lines = current_text.unwrap_or("").lines().collect::<Vec<_>>();
        let mut codes = BTreeMap::<u32, usize>::new();
        let mut malformed_lines = 0;
        for line in &lines {
            let code = line
                .split_whitespace()
                .find_map(|field| field.strip_prefix("code="))
                .and_then(|value| value.parse::<u32>().ok());
            match code {
                Some(code) => *codes.entry(code).or_default() += 1,
                None => malformed_lines += 1,
            }
        }
        let exact_codes = (0..WRITERS)
            .filter(|writer| {
                codes.get(&(1_000_000 + (round * WRITERS + *writer) as u32)) == Some(&1)
            })
            .count();
        let within_cap = current_len as u64 <= product_logging::LOG_LIMIT;
        let outcome = format!("round={round} panics={panic_count} writeErrors={write_errors} readErrors={read_errors} seedEqual={seed_equal} previousBytes={previous_len} currentBytes={current_len} withinCap={within_cap} lines={} malformedLines={malformed_lines} distinctCodes={} exactCodes={exact_codes}", lines.len(), codes.len());
        println!("LOG_ROTATION_CONCURRENCY {outcome}");
        if panic_count != 0
            || write_errors != 0
            || read_errors != 0
            || !seed_equal
            || !within_cap
            || lines.len() != WRITERS
            || malformed_lines != 0
            || codes.len() != WRITERS
            || exact_codes != WRITERS
        {
            failures.push(outcome);
        }
    }
    assert!(
        failures.is_empty(),
        "concurrent log rotation failed:\n{}",
        failures.join("\n")
    );
}
