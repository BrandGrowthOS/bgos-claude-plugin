#![windows_subsystem = "windows"]

#[path = "../tests/support/mod.rs"]
mod support;

use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use std::thread::sleep;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use support::{cleanup_failure_count, scratch, Fixture};

fn clock_ticks() -> Result<u64, String> {
    let ticks = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos()
        / 100
        + 116_444_736_000_000_000;
    u64::try_from(ticks).map_err(|error| error.to_string())
}

fn statistics(values: &[f64]) -> Value {
    let mut ordered = values.to_vec();
    ordered.sort_by(f64::total_cmp);
    json!({"median":(ordered[9]+ordered[10])/2.0,"worst":ordered[19]})
}

struct Sample {
    launch_ms: f64,
    cpu_ms: f64,
    read_bytes: u64,
    peak_memory: usize,
}

fn sample(helper: &std::path::Path, index: usize, attempt: usize) -> Result<Sample, String> {
    println!("STARTUP_ATTEMPT run={index} attempt={attempt}");
    let mut fixture = Fixture::new(&format!("startup-cost-{index}-{attempt}"))?;
    fixture.binary = helper.to_path_buf();
    let mut run = fixture.launch("run", &[], false)?;
    let state = run.wait_state(|state| state["watcherPid"].as_u64().is_some_and(|pid| pid > 0))?;
    let pid = state["watcherPid"]
        .as_u64()
        .ok_or("state watcher pid missing")? as u32;
    let creation = run.process(pid).creation;
    let launch_ms = creation
        .checked_sub(run.helper.creation)
        .ok_or("fake creation predates helper")? as f64
        / 10_000.0;
    let target_sample = creation
        .checked_add(20_000_000)
        .ok_or("sample time overflow")?;
    let state_arrival = clock_ticks()?;
    if state_arrival > target_sample {
        return Err(format!(
            "INCONCLUSIVE: state arrived after sample target; stateArrivalDelayMs={:.6}",
            state_arrival.saturating_sub(creation) as f64 / 10_000.0
        ));
    }
    loop {
        let now = clock_ticks()?;
        if now >= target_sample {
            break;
        }
        sleep(Duration::from_nanos(
            ((target_sample - now) * 100).min(10_000_000),
        ));
    }
    if !run.helper.running() || !run.process(pid).running() {
        return Err("measurement process ended before sample".to_owned());
    }
    let sample_time = clock_ticks()?;
    let (cpu_ms, read_bytes, peak_memory) = run.helper.metrics()?;
    let sample_end = clock_ticks()?;
    let sample_delay_ms = sample_time
        .checked_sub(creation)
        .ok_or("sample predates fake creation")? as f64
        / 10_000.0;
    let sample_end_delay_ms = sample_end
        .checked_sub(creation)
        .ok_or("sample predates fake creation")? as f64
        / 10_000.0;
    println!("STARTUP_SAMPLE run={index} attempt={attempt} launchMs={launch_ms:.6} cpuMs={cpu_ms:.6} readBytes={read_bytes} peakMemoryBytes={peak_memory} sampleDelayMs={sample_delay_ms:.6} sampleEndDelayMs={sample_end_delay_ms:.6}");
    // This is a conservative measurement-quality cap, not an acceptance tolerance.
    if sample_end.saturating_sub(target_sample) > 1_000_000 {
        return Err(format!("INCONCLUSIVE: scheduler overshot sample target; sampleDelayMs={sample_delay_ms:.6} sampleEndDelayMs={sample_end_delay_ms:.6}"));
    }
    let observations = run.wait_observations(1)?;
    if !observations
        .iter()
        .any(|value| value["pid"].as_u64() == Some(u64::from(pid)))
    {
        return Err("measured fake did not provide its behavioral observation".to_owned());
    }
    if !run.helper.running() || !run.process(pid).running() {
        return Err("measurement process ended before observation".to_owned());
    }
    drop(run);
    drop(fixture);
    if cleanup_failure_count() != 0 {
        return Err("process cleanup failed during measurement".to_owned());
    }
    Ok(Sample {
        launch_ms,
        cpu_ms,
        read_bytes,
        peak_memory,
    })
}

fn measure() -> Result<(), String> {
    let target =
        PathBuf::from(std::env::var_os("CARGO_TARGET_DIR").ok_or("CARGO_TARGET_DIR required")?);
    let helper = target.join("release").join("hoai-helper.exe");
    if !helper.is_file() {
        return Err("release helper is missing".to_owned());
    }
    let mut launch_values = Vec::new();
    let mut cpu_values = Vec::new();
    let mut read_values = Vec::new();
    let mut memory_values = Vec::new();
    let mut csv = String::from("run,launchMs,cpuMs,readBytes,peakMemoryBytes\n");
    for index in 1..=20 {
        let mut accepted = None;
        for attempt in 1..=3 {
            match sample(&helper, index, attempt) {
                Ok(value) => {
                    accepted = Some(value);
                    break;
                }
                Err(problem) if problem.starts_with("INCONCLUSIVE:") && attempt < 3 => {
                    println!("STARTUP_RETRY run={index} attempt={attempt} {problem}")
                }
                Err(problem) => return Err(problem),
            }
        }
        let value = accepted.ok_or("no valid measurement after bounded retries")?;
        csv.push_str(&format!(
            "{index},{:.6},{:.6},{},{}\n",
            value.launch_ms, value.cpu_ms, value.read_bytes, value.peak_memory
        ));
        launch_values.push(value.launch_ms);
        cpu_values.push(value.cpu_ms);
        read_values.push(value.read_bytes as f64);
        memory_values.push(value.peak_memory as f64);
        fs::write(PathBuf::from(scratch()).join("startup-cost.csv"), &csv)
            .map_err(|error| error.to_string())?;
    }
    let summary = json!({
        "measurementContext":"measured inside a breakaway-refusing job",
        "pcContext":"busy PC with other lanes running, not the clean PC budget",
        "timing":"target is fake creation plus 2s; actual sample delays are retained in the run log",
        "runs":20,
        "launchMs":statistics(&launch_values),
        "cpuMs":statistics(&cpu_values),
        "readBytes":statistics(&read_values),
        "peakMemoryBytes":statistics(&memory_values),
        "lowReference":{"cpuMs":300,"readBytes":300000}
    });
    fs::write(
        PathBuf::from(scratch()).join("startup-cost-summary.json"),
        serde_json::to_vec_pretty(&summary).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    println!("STARTUP_SUMMARY {summary}");
    Ok(())
}

fn main() {
    match std::panic::catch_unwind(measure) {
        Ok(Ok(())) => {}
        Ok(Err(problem)) => {
            eprintln!("STARTUP_COST_FAILED {problem}");
            std::process::exit(1);
        }
        Err(_) => {
            eprintln!("STARTUP_COST_FAILED harness assertion");
            std::process::exit(1);
        }
    }
}
