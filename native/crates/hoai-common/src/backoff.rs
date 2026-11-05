use std::time::Duration;

/// Q10: may a state replace be retried, given the error and the retries already made?
pub fn state_retry_allowed(os_error: Option<i32>, retries_done: u32) -> bool {
    matches!(os_error, Some(5 | 32)) && retries_done < 5
}

/// Failures to count after a watcher run ends.
pub fn next_failure_count(consecutive_failures: u32, uptime_secs: u64) -> u32 {
    if uptime_secs >= 600 {
        return 1;
    }
    consecutive_failures.saturating_add(1)
}

pub fn restart_delay(consecutive_failures: u32, uptime_secs: u64) -> Duration {
    if uptime_secs >= 600 {
        return Duration::from_secs(1);
    }
    Duration::from_secs(
        1_u64
            .checked_shl(consecutive_failures)
            .unwrap_or(u64::MAX)
            .min(300),
    )
}
