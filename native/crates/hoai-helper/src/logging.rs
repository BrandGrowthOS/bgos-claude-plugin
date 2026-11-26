use hoai_common::win32::OwnedHandle;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::os::windows::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use windows_sys::Win32::Foundation::{
    ERROR_ACCESS_DENIED, ERROR_BUFFER_OVERFLOW, ERROR_INVALID_DATA, ERROR_TIMEOUT, WAIT_ABANDONED,
    WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::Storage::FileSystem::{
    MoveFileExW, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, MOVEFILE_REPLACE_EXISTING,
    MOVEFILE_WRITE_THROUGH,
};
use windows_sys::Win32::System::Threading::{CreateMutexW, ReleaseMutex, WaitForSingleObject};

pub const LOG_LIMIT: u64 = 1024 * 1024;

pub struct Logger {
    path: PathBuf,
    previous: PathBuf,
}

struct LogLock {
    handle: OwnedHandle,
}

impl LogLock {
    fn acquire(path: &Path) -> io::Result<Self> {
        let full = hoai_common::win32::full_path(&path.to_string_lossy())?;
        let canonical = hoai_common::canonical_home(&full);
        let digest = hoai_common::sha256_hex(canonical.as_bytes())?;
        let name = hoai_common::win32::wide(&format!("Local\\HOAI-Helper-Log-{digest}"));
        let raw = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
        if raw.is_null() {
            return Err(io::Error::last_os_error());
        }
        let handle = unsafe { OwnedHandle::from_raw(raw) };
        match unsafe { WaitForSingleObject(handle.as_raw(), 5000) } {
            WAIT_OBJECT_0 | WAIT_ABANDONED => Ok(Self { handle }),
            WAIT_TIMEOUT => Err(io::Error::from_raw_os_error(ERROR_TIMEOUT as i32)),
            WAIT_FAILED => Err(io::Error::last_os_error()),
            _ => Err(io::Error::from_raw_os_error(ERROR_INVALID_DATA as i32)),
        }
    }
}

impl Drop for LogLock {
    fn drop(&mut self) {
        // This guard exists only after the current thread acquired ownership.
        // The OwnedHandle field closes the handle after this release.
        unsafe { ReleaseMutex(self.handle.as_raw()) };
    }
}

impl Logger {
    pub fn new(directory: &Path) -> Self {
        Self {
            path: directory.join("helper.log"),
            previous: directory.join("helper.log.1"),
        }
    }

    pub fn record(&self, code: u32, path: Option<&Path>, pid: Option<u32>) -> io::Result<()> {
        let time = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(io::Error::other)?
            .as_millis();
        let mut line = format!("time={time} code={code}");
        if let Some(path) = path {
            // Keep normal path spelling and prevent a path from adding a line.
            let path = path
                .to_string_lossy()
                .replace('\r', "\\r")
                .replace('\n', "\\n");
            line.push_str(" path=");
            line.push_str(&path);
        }
        if let Some(pid) = pid {
            line.push_str(&format!(" pid={pid}"));
        }
        line.push('\n');
        if line.len() as u64 > LOG_LIMIT {
            return Err(io::Error::from_raw_os_error(ERROR_BUFFER_OVERFLOW as i32));
        }

        let _lock = LogLock::acquire(&self.path)?;
        let length = match fs::metadata(&self.path) {
            Ok(metadata) if metadata.is_file() => metadata.len(),
            Ok(_) => return Err(io::Error::from_raw_os_error(ERROR_ACCESS_DENIED as i32)),
            Err(problem) if problem.kind() == io::ErrorKind::NotFound => 0,
            Err(problem) => return Err(problem),
        };
        if length.saturating_add(line.len() as u64) > LOG_LIMIT {
            let current = hoai_common::win32::wide(&self.path.to_string_lossy());
            let previous = hoai_common::win32::wide(&self.previous.to_string_lossy());
            if unsafe {
                MoveFileExW(
                    current.as_ptr(),
                    previous.as_ptr(),
                    MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
                )
            } == 0
            {
                return Err(io::Error::last_os_error());
            }
        }

        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .open(&self.path)?;
        file.write_all(line.as_bytes())?;
        drop(file);
        Ok(())
    }
}
