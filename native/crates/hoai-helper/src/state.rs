use hoai_common::state_retry_allowed;
use serde::Serialize;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::AsRawHandle;
use std::path::Path;
use std::thread::sleep;
use std::time::Duration;
use windows_sys::Win32::Foundation::ERROR_INVALID_DATA;
use windows_sys::Win32::Storage::FileSystem::{
    FlushFileBuffers, MoveFileExW, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HelperState {
    pub schema: u32,
    pub helper_pid: u32,
    pub helper_creation_time: String,
    pub watcher_pid: u32,
    pub watcher_creation_time: String,
    pub restart_count: u64,
    pub last_error_code: u32,
    pub last_error_path: Option<String>,
    pub in_job: String,
    pub in_job_error_code: u32,
}

impl HelperState {
    pub fn new(helper_pid: u32, helper_creation: u64, in_job: &str, in_job_error: u32) -> Self {
        Self {
            schema: 1,
            helper_pid,
            helper_creation_time: helper_creation.to_string(),
            watcher_pid: 0,
            watcher_creation_time: "0".to_owned(),
            restart_count: 0,
            last_error_code: 0,
            last_error_path: None,
            in_job: in_job.to_owned(),
            in_job_error_code: in_job_error,
        }
    }
}

pub fn publish(directory: &Path, state: &HelperState) -> io::Result<()> {
    let target = directory.join("helper-state.json");
    let temporary = directory.join(format!("helper-state.json.{}.tmp", state.helper_pid));
    let mut bytes = serde_json::to_vec(state)
        .map_err(|_| io::Error::from_raw_os_error(ERROR_INVALID_DATA as i32))?;
    bytes.push(b'\n');
    let mut owns_temporary = false;
    let mut retries_done = 0;
    loop {
        match write_and_replace(&temporary, &target, &bytes, &mut owns_temporary) {
            Ok(()) => return Ok(()),
            Err(problem) => {
                if state_retry_allowed(problem.raw_os_error(), retries_done) {
                    retries_done += 1;
                    sleep(Duration::from_millis(100));
                    continue;
                }
                if owns_temporary {
                    match fs::remove_file(&temporary) {
                        Ok(()) => {}
                        Err(cleanup) if cleanup.kind() == io::ErrorKind::NotFound => {}
                        Err(cleanup) => return Err(cleanup),
                    }
                }
                return Err(problem);
            }
        }
    }
}

fn write_and_replace(
    temporary: &Path,
    target: &Path,
    bytes: &[u8],
    owns_temporary: &mut bool,
) -> io::Result<()> {
    {
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .open(temporary)?;
        *owns_temporary = true;
        file.write_all(bytes)?;
        if unsafe { FlushFileBuffers(file.as_raw_handle()) } == 0 {
            return Err(io::Error::last_os_error());
        }
    }
    let temporary = hoai_common::win32::wide(&temporary.to_string_lossy());
    let target = hoai_common::win32::wide(&target.to_string_lossy());
    if unsafe {
        MoveFileExW(
            temporary.as_ptr(),
            target.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    *owns_temporary = false;
    Ok(())
}
