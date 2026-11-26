#![allow(dead_code)]

use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::ffi::{OsStr, OsString};
use std::fs;
use std::mem::{size_of, zeroed};
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::os::windows::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::ptr::{null, null_mut};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::sleep;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use windows_sys::Win32::Foundation::{
    CloseHandle, FILETIME, HANDLE, HWND, INVALID_HANDLE_VALUE, LPARAM, WAIT_TIMEOUT,
};
use windows_sys::Win32::Storage::FileSystem::{CreateFileW, GetFullPathNameW};
use windows_sys::Win32::System::Com::CoTaskMemFree;
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::Environment::{FreeEnvironmentStringsW, GetEnvironmentStringsW};
use windows_sys::Win32::System::JobObjects::{
    CreateJobObjectW, IsProcessInJob, JobObjectExtendedLimitInformation, SetInformationJobObject,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_BREAKAWAY_OK,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
use windows_sys::Win32::System::Registry::{
    RegCloseKey, RegCreateKeyExW, RegDeleteKeyW, RegDeleteTreeW, RegEnumValueW, RegOpenKeyExW,
    RegQueryValueExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_QUERY_VALUE, KEY_READ,
    KEY_WRITE, REG_OPTION_NON_VOLATILE, REG_OPTION_VOLATILE, REG_SZ,
};
use windows_sys::Win32::System::Threading::{
    CreateProcessW, DeleteProcThreadAttributeList, GetCurrentProcess, GetExitCodeProcess,
    GetProcessIoCounters, GetProcessTimes, InitializeProcThreadAttributeList, OpenProcess,
    QueryFullProcessImageNameW, TerminateProcess, UpdateProcThreadAttribute, WaitForSingleObject,
    IO_COUNTERS, PROCESS_INFORMATION, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
    PROC_THREAD_ATTRIBUTE_JOB_LIST, STARTUPINFOEXW,
};
use windows_sys::Win32::UI::Shell::{FOLDERID_Profile, SHGetKnownFolderPath};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetForegroundWindow, GetWindowThreadProcessId, IsWindowVisible,
};

/// Every fixture, record and log of these tests lives in one folder under the temp dir (TMP or TEMP).
pub fn scratch() -> &'static str {
    static SCRATCH: OnceLock<String> = OnceLock::new();
    SCRATCH.get_or_init(|| {
        std::env::temp_dir()
            .join("hoai-helper-tests")
            .to_string_lossy()
            .into_owned()
    })
}

/// The installed Node under %ProgramFiles%, the only image the fake watcher may run.
pub fn node_image() -> &'static str {
    static NODE: OnceLock<String> = OnceLock::new();
    NODE.get_or_init(|| {
        let root =
            std::env::var("ProgramFiles").expect("ProgramFiles names the installed Node folder");
        format!("{}\\nodejs\\node.exe", root.trim_end_matches('\\'))
    })
}

/// CARGO_TARGET_DIR when set; otherwise the target folder three levels above this test or example binary.
pub fn target_dir() -> Result<String, String> {
    if let Some(value) = std::env::var_os("CARGO_TARGET_DIR") {
        return Ok(value.to_string_lossy().into_owned());
    }
    let exe = std::env::current_exe().map_err(|problem| problem.to_string())?;
    exe.ancestors()
        .nth(3)
        .map(|target| target.to_string_lossy().into_owned())
        .ok_or_else(|| "no target folder above the test binary".to_owned())
}
static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);
static CLEANUP_FAILURES: AtomicU64 = AtomicU64::new(0);

fn cleanup_failure(message: String) {
    CLEANUP_FAILURES.fetch_add(1, Ordering::SeqCst);
    eprintln!("{message}");
}

pub fn cleanup_failure_count() -> u64 {
    CLEANUP_FAILURES.load(Ordering::SeqCst)
}

fn error(context: &str) -> String {
    format!(
        "{context}: Windows code {}",
        std::io::Error::last_os_error().raw_os_error().unwrap_or(0)
    )
}

pub fn wide(value: impl AsRef<OsStr>) -> Vec<u16> {
    value.as_ref().encode_wide().chain(Some(0)).collect()
}

pub fn full_path(value: &str) -> Result<String, String> {
    let source = wide(value.replace('/', "\\"));
    let mut destination = vec![0_u16; 32768];
    let length = unsafe {
        GetFullPathNameW(
            source.as_ptr(),
            destination.len() as u32,
            destination.as_mut_ptr(),
            null_mut(),
        )
    };
    if length == 0 || length as usize >= destination.len() {
        return Err(error("full path"));
    }
    Ok(String::from_utf16_lossy(&destination[..length as usize]))
}

pub fn path_key(value: &str) -> Result<String, String> {
    Ok(full_path(value)?.trim_end_matches('\\').to_lowercase())
}

pub fn same_or_under(candidate: &str, parent: &str) -> bool {
    candidate == parent
        || candidate
            .strip_prefix(parent)
            .is_some_and(|suffix| suffix.starts_with('\\'))
}

fn reject_reparse_ancestors(path: &Path) -> Result<(), String> {
    let ancestors = path.ancestors().collect::<Vec<_>>();
    for ancestor in ancestors.into_iter().rev() {
        match fs::symlink_metadata(ancestor) {
            Ok(metadata) if metadata.file_attributes() & 0x400 != 0 => {
                return Err("scratch path contains a reparse point".to_owned())
            }
            Ok(_) => {}
            Err(problem) if problem.kind() == std::io::ErrorKind::NotFound => {}
            Err(problem) => return Err(problem.to_string()),
        }
    }
    Ok(())
}

#[derive(Clone, Debug)]
pub struct LaunchSafety {
    pub home: String,
    pub node_path: String,
    pub watcher_dir: String,
    pub state_dir: String,
    pub fixture_root: String,
}

pub fn harness_in_job() -> Result<bool, String> {
    let mut result = 0;
    if unsafe { IsProcessInJob(GetCurrentProcess(), null_mut(), &mut result) } == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(result != 0)
}

/// The SID of this process's user, read here so the proof does not rest on the helper's own read.
pub fn current_user_sid() -> Result<String, String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
    use windows_sys::Win32::Security::{GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER};
    use windows_sys::Win32::System::Threading::OpenProcessToken;
    let mut token = null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    let mut length = 0_u32;
    unsafe { GetTokenInformation(token, TokenUser, null_mut(), 0, &mut length) };
    let mut storage = vec![0_usize; (length as usize).div_ceil(size_of::<usize>())];
    let read = unsafe {
        GetTokenInformation(
            token,
            TokenUser,
            storage.as_mut_ptr().cast(),
            length,
            &mut length,
        )
    };
    let read_error = std::io::Error::last_os_error();
    unsafe { CloseHandle(token) };
    if read == 0 {
        return Err(read_error.to_string());
    }
    let user = unsafe { &*storage.as_ptr().cast::<TOKEN_USER>() };
    let mut text = null_mut();
    if unsafe { ConvertSidToStringSidW(user.User.Sid, &mut text) } == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    let mut units = 0;
    unsafe {
        while *text.add(units) != 0 {
            units += 1;
        }
    }
    let sid = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(text, units) });
    unsafe { LocalFree(text.cast()) };
    Ok(sid)
}

/// Read only, to prove a refused write left nothing. Opens for query, under HKCU, and creates nothing.
pub fn registry_key_exists(path: &str) -> bool {
    let mut handle = null_mut();
    let path = wide(path);
    let code = unsafe {
        RegOpenKeyExW(
            HKEY_CURRENT_USER,
            path.as_ptr(),
            0,
            KEY_QUERY_VALUE,
            &mut handle,
        )
    };
    if code != 0 {
        return false;
    }
    unsafe { RegCloseKey(handle) };
    true
}

/// Read only. Asks whether one exact value name exists and reads no value data.
pub fn registry_value_exists(path: &str, value: &str) -> bool {
    let mut handle = null_mut();
    let path = wide(path);
    let value = wide(value);
    let code = unsafe {
        RegOpenKeyExW(
            HKEY_CURRENT_USER,
            path.as_ptr(),
            0,
            KEY_QUERY_VALUE,
            &mut handle,
        )
    };
    if code != 0 {
        return false;
    }
    let found = unsafe {
        RegQueryValueExW(
            handle,
            value.as_ptr(),
            null(),
            null_mut(),
            null_mut(),
            null_mut(),
        )
    } == 0;
    unsafe { RegCloseKey(handle) };
    found
}

/// True when a mutex of exactly this name is open somewhere in this session.
pub fn named_mutex_exists(name: &str) -> bool {
    use windows_sys::Win32::System::Threading::OpenMutexW;
    const SYNCHRONIZE_ACCESS: u32 = 0x0010_0000;
    let name = wide(name);
    let handle = unsafe { OpenMutexW(SYNCHRONIZE_ACCESS, 0, name.as_ptr()) };
    if handle.is_null() {
        return false;
    }
    unsafe { CloseHandle(handle) };
    true
}

pub fn real_profiles() -> Result<Vec<String>, String> {
    let mut profiles = vec![std::env::var("USERPROFILE").map_err(|e| e.to_string())?];
    let mut path = null_mut();
    let status = unsafe { SHGetKnownFolderPath(&FOLDERID_Profile, 0, null_mut(), &mut path) };
    if status < 0 || path.is_null() {
        return Err(format!("profile lookup failed: {status}"));
    }
    let mut length = 0;
    unsafe {
        while *path.add(length) != 0 {
            length += 1;
        }
        profiles.push(
            OsString::from_wide(std::slice::from_raw_parts(path, length))
                .to_string_lossy()
                .into_owned(),
        );
        CoTaskMemFree(path.cast());
    }
    profiles.sort();
    profiles.dedup();
    Ok(profiles)
}

pub fn validate_launch_config(config: &LaunchSafety, profiles: &[String]) -> Result<(), String> {
    if profiles.is_empty() {
        return Err("real profile boundary is unavailable".to_owned());
    }
    let fields = [
        &config.home,
        &config.node_path,
        &config.watcher_dir,
        &config.state_dir,
        &config.fixture_root,
    ];
    for field in fields {
        let bytes = field.as_bytes();
        if bytes.len() < 3
            || !bytes[0].is_ascii_alphabetic()
            || bytes[1] != b':'
            || ![b'\\', b'/'].contains(&bytes[2])
            || field.contains('"')
            || field.contains('\0')
        {
            return Err("harness requires absolute drive paths without quotes or NUL".to_owned());
        }
    }
    let home = path_key(&config.home)?;
    let node = path_key(&config.node_path)?;
    let watcher = path_key(&config.watcher_dir)?;
    let state = path_key(&config.state_dir)?;
    let root = path_key(&config.fixture_root)?;
    for profile in profiles {
        let profile = path_key(profile)?;
        if home == profile {
            return Err("harness refuses real profile home".to_owned());
        }
        let agent = format!("{profile}\\.bgos-agent");
        if [&home, &node, &watcher, &state, &root]
            .iter()
            .any(|field| same_or_under(field, &agent))
        {
            return Err("harness refuses real agent paths".to_owned());
        }
    }
    let runs = path_key(&format!("{}\\runs", scratch()))?;
    if root == runs || !same_or_under(&root, &runs) {
        return Err("fixture root must be a unique scratch run".to_owned());
    }
    for field in [&home, &watcher, &state] {
        if !same_or_under(field, &root) {
            return Err("fixture path leaves owned run".to_owned());
        }
        reject_reparse_ancestors(Path::new(field))?;
    }
    reject_reparse_ancestors(Path::new(&root))?;
    if node != path_key(node_image())? {
        if !same_or_under(&node, &root) {
            return Err("node must be installed node or an absent owned path".to_owned());
        }
        reject_reparse_ancestors(Path::new(&node))?;
        match fs::symlink_metadata(&node) {
            Ok(_) => return Err("harness refuses an existing alternate node image".to_owned()),
            Err(problem) if problem.kind() == std::io::ErrorKind::NotFound => {}
            Err(problem) => return Err(problem.to_string()),
        }
    }
    let recorded_watcher = path_key(&format!("{root}\\fake-watcher"))?;
    match fs::symlink_metadata(&watcher) {
        Ok(metadata) if watcher == recorded_watcher && metadata.is_dir() => {}
        Ok(_) => return Err("harness refuses an existing alternate watcher directory".to_owned()),
        Err(problem) if problem.kind() == std::io::ErrorKind::NotFound => {}
        Err(problem) => return Err(problem.to_string()),
    }
    Ok(())
}

pub fn helper_path() -> PathBuf {
    if let Some(path) = option_env!("CARGO_BIN_EXE_hoai-helper") {
        return PathBuf::from(path);
    }
    PathBuf::from(target_dir().expect("target folder"))
        .join("release")
        .join("hoai-helper.exe")
}

pub fn filetime(value: FILETIME) -> u64 {
    (u64::from(value.dwHighDateTime) << 32) | u64::from(value.dwLowDateTime)
}

#[derive(Debug)]
pub struct Process {
    pub handle: HANDLE,
    pub pid: u32,
    pub creation: u64,
}

impl Process {
    fn from_handle(handle: HANDLE, pid: u32) -> Result<Self, String> {
        let mut process = Self {
            handle,
            pid,
            creation: 0,
        };
        process.creation = process.times()?.0;
        Ok(process)
    }

    pub fn open(
        pid: u32,
        expected_creation: Option<u64>,
        expected_image: &Path,
    ) -> Result<Self, String> {
        let expected_creation =
            expected_creation.ok_or("owned process creation time is required")?;
        Self::open_in_creation_range(pid, expected_creation, expected_creation, expected_image)
    }

    fn open_in_creation_range(
        pid: u32,
        minimum: u64,
        maximum: u64,
        expected_image: &Path,
    ) -> Result<Self, String> {
        let handle = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | 0x00100000,
                0,
                pid,
            )
        };
        if handle.is_null() {
            return Err(error("open owned process"));
        }
        let verified = (|| {
            let image_matches = path_key(&image_for_handle(handle)?)?
                == path_key(&expected_image.to_string_lossy())?;
            let mut created = unsafe { zeroed() };
            let mut exited = unsafe { zeroed() };
            let mut kernel = unsafe { zeroed() };
            let mut user = unsafe { zeroed() };
            if unsafe { GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) }
                == 0
            {
                return Err(error("verify process creation"));
            }
            let creation = filetime(created);
            if !image_matches || creation < minimum || creation > maximum {
                return Err("owned process identity mismatch".to_owned());
            }
            Ok(Self {
                handle,
                pid,
                creation,
            })
        })();
        if verified.is_err() {
            unsafe {
                CloseHandle(handle);
            }
        }
        verified
    }

    fn close_without_ending(&mut self) {
        if !self.handle.is_null() {
            unsafe {
                CloseHandle(self.handle);
            }
            self.handle = null_mut();
        }
    }

    pub fn running(&self) -> bool {
        !self.handle.is_null() && unsafe { WaitForSingleObject(self.handle, 0) } == WAIT_TIMEOUT
    }

    pub fn exit_code(&self, timeout: Duration) -> Result<u32, String> {
        if unsafe {
            WaitForSingleObject(
                self.handle,
                timeout.as_millis().min(u32::MAX as u128) as u32,
            )
        } == WAIT_TIMEOUT
        {
            return Err("owned process did not exit before deadline".to_owned());
        }
        let mut result = 0;
        if unsafe { GetExitCodeProcess(self.handle, &mut result) } == 0 {
            return Err(error("exit code"));
        }
        Ok(result)
    }

    pub fn image(&self) -> Result<String, String> {
        image_for_handle(self.handle)
    }

    pub fn times(&self) -> Result<(u64, u64, u64), String> {
        let mut created = unsafe { zeroed() };
        let mut exited = unsafe { zeroed() };
        let mut kernel = unsafe { zeroed() };
        let mut user = unsafe { zeroed() };
        if unsafe {
            GetProcessTimes(
                self.handle,
                &mut created,
                &mut exited,
                &mut kernel,
                &mut user,
            )
        } == 0
        {
            return Err(error("process times"));
        }
        Ok((
            filetime(created),
            filetime(exited),
            filetime(kernel) + filetime(user),
        ))
    }

    pub fn in_job(&self) -> Result<bool, String> {
        let mut result = 0;
        if unsafe { IsProcessInJob(self.handle, null_mut(), &mut result) } == 0 {
            return Err(error("owned job query"));
        }
        Ok(result != 0)
    }

    /// True when this process is in the job named, not merely in some job.
    pub fn in_this_job(&self, job: &Job) -> Result<bool, String> {
        let mut result = 0;
        if unsafe { IsProcessInJob(self.handle, job.0, &mut result) } == 0 {
            return Err(error("named job query"));
        }
        Ok(result != 0)
    }

    pub fn metrics(&self) -> Result<(f64, u64, usize), String> {
        let cpu = self.times()?.2 as f64 / 10_000.0;
        let mut io: IO_COUNTERS = unsafe { zeroed() };
        if unsafe { GetProcessIoCounters(self.handle, &mut io) } == 0 {
            return Err(error("process IO"));
        }
        let mut memory: PROCESS_MEMORY_COUNTERS = unsafe { zeroed() };
        memory.cb = size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
        let memory_size = memory.cb;
        if unsafe { GetProcessMemoryInfo(self.handle, &mut memory, memory_size) } == 0 {
            return Err(error("process memory"));
        }
        Ok((cpu, io.ReadTransferCount, memory.PeakWorkingSetSize))
    }

    pub fn end(&self) -> Result<(), String> {
        if self.running() && unsafe { TerminateProcess(self.handle, 99) } == 0 {
            return Err(error("end owned process"));
        }
        self.exit_code(Duration::from_secs(5)).map(|_| ())
    }
}

#[derive(Clone)]
struct HelperIdentity {
    pid: u32,
    creation: u64,
    path: PathBuf,
}

fn helper_snapshot() -> Result<Vec<HelperIdentity>, String> {
    helper_snapshot_inner(false)
}

fn helper_snapshot_inner(strict: bool) -> Result<Vec<HelperIdentity>, String> {
    let target = path_key(&target_dir()?)?;
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(error("helper process snapshot"));
    }
    let mut entry: PROCESSENTRY32W = unsafe { zeroed() };
    entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
    let mut next = unsafe { Process32FirstW(snapshot, &mut entry) };
    let mut result = Vec::new();
    let mut failure = None;
    while next != 0 {
        let length = entry
            .szExeFile
            .iter()
            .position(|unit| *unit == 0)
            .unwrap_or(entry.szExeFile.len());
        if String::from_utf16_lossy(&entry.szExeFile[..length])
            .eq_ignore_ascii_case("hoai-helper.exe")
        {
            let handle =
                unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, entry.th32ProcessID) };
            if !handle.is_null() {
                if let Ok(path) = image_for_handle(handle) {
                    if path_key(&path).is_ok_and(|path| same_or_under(&path, &target)) {
                        let mut created = unsafe { zeroed() };
                        let mut exited = unsafe { zeroed() };
                        let mut kernel = unsafe { zeroed() };
                        let mut user = unsafe { zeroed() };
                        if unsafe {
                            GetProcessTimes(
                                handle,
                                &mut created,
                                &mut exited,
                                &mut kernel,
                                &mut user,
                            )
                        } != 0
                        {
                            result.push(HelperIdentity {
                                pid: entry.th32ProcessID,
                                creation: filetime(created),
                                path: PathBuf::from(path),
                            });
                        } else if strict {
                            failure = Some(error("verify target helper creation"));
                        }
                    }
                } else if strict {
                    failure = Some(error("verify helper image"));
                }
                unsafe {
                    CloseHandle(handle);
                }
            } else if strict && std::io::Error::last_os_error().raw_os_error() != Some(87) {
                failure = Some(error("open helper for final snapshot"));
            }
        }
        next = unsafe { Process32NextW(snapshot, &mut entry) };
    }
    unsafe {
        CloseHandle(snapshot);
    }
    match failure {
        Some(problem) => Err(problem),
        None => Ok(result),
    }
}

fn current_filetime() -> Result<u64, String> {
    let ticks = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos()
        / 100
        + 116_444_736_000_000_000;
    u64::try_from(ticks).map_err(|e| e.to_string())
}

fn current_parent_pid(pid: u32) -> Option<u32> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return None;
    }
    let mut entry: PROCESSENTRY32W = unsafe { zeroed() };
    entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
    let mut next = unsafe { Process32FirstW(snapshot, &mut entry) };
    let mut parent = None;
    while next != 0 {
        if entry.th32ProcessID == pid {
            parent = Some(entry.th32ParentProcessID);
            break;
        }
        next = unsafe { Process32NextW(snapshot, &mut entry) };
    }
    unsafe {
        CloseHandle(snapshot);
    }
    parent
}

fn capture_owned_node_children(
    parents: &[&Process],
    known: &BTreeSet<u32>,
    root: &Path,
) -> Result<Vec<Process>, String> {
    let upper = current_filetime()?;
    let mut intervals = BTreeMap::new();
    for parent in parents {
        let (created, exited, _) = parent.times()?;
        intervals.insert(
            parent.pid,
            (created, if exited == 0 { upper } else { exited }),
        );
    }
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(error("owned child snapshot"));
    }
    let mut entry: PROCESSENTRY32W = unsafe { zeroed() };
    entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
    let mut next = unsafe { Process32FirstW(snapshot, &mut entry) };
    let mut children = Vec::new();
    while next != 0 {
        if !known.contains(&entry.th32ProcessID) {
            if let Some((created, exited)) = intervals.get(&entry.th32ParentProcessID) {
                let length = entry
                    .szExeFile
                    .iter()
                    .position(|unit| *unit == 0)
                    .unwrap_or(entry.szExeFile.len());
                if String::from_utf16_lossy(&entry.szExeFile[..length])
                    .eq_ignore_ascii_case("node.exe")
                {
                    match Process::open_in_creation_range(
                        entry.th32ProcessID,
                        *created,
                        *exited,
                        Path::new(node_image()),
                    ) {
                        Ok(mut child) => {
                            let current_parent = current_parent_pid(child.pid);
                            if current_parent != Some(entry.th32ParentProcessID) {
                                if current_parent.is_none() && child.running() {
                                    cleanup_failure(format!(
                                        "CLEANUP_CHILD_PARENT_RECHECK_FAILED pid={}",
                                        child.pid
                                    ));
                                }
                                child.close_without_ending();
                                next = unsafe { Process32NextW(snapshot, &mut entry) };
                                continue;
                            }
                            let record = json!({"kind":"native-cleanup-identity","pid":child.pid,"creationTime":child.creation.to_string(),"image":node_image(),"parentPid":entry.th32ParentProcessID});
                            let path = root.join(format!(
                                "cleanup-identity-node-{}-{}.json",
                                child.pid, child.creation
                            ));
                            match serde_json::to_vec(&record)
                                .map_err(|e| e.to_string())
                                .and_then(|data| fs::write(&path, data).map_err(|e| e.to_string()))
                            {
                                Ok(()) => children.push(child),
                                Err(problem) => {
                                    cleanup_failure(format!(
                                        "CLEANUP_IDENTITY_WRITE_FAILED pid={} {problem}",
                                        child.pid
                                    ));
                                    children.push(child);
                                }
                            }
                        }
                        Err(problem) => {
                            if !problem.contains("identity mismatch")
                                && !problem.contains("Windows code 87")
                                && !problem.contains("Windows code 6")
                            {
                                cleanup_failure(format!(
                                    "CLEANUP_CHILD_CAPTURE_FAILED pid={} {problem}",
                                    entry.th32ProcessID
                                ));
                            }
                        }
                    }
                }
            }
        }
        next = unsafe { Process32NextW(snapshot, &mut entry) };
    }
    unsafe {
        CloseHandle(snapshot);
    }
    Ok(children)
}

impl Drop for Process {
    fn drop(&mut self) {
        if !self.handle.is_null() {
            if self.running() {
                if let Err(problem) = self.end() {
                    cleanup_failure(format!("PROCESS_CLEANUP_FAILED pid={} {problem}", self.pid));
                }
            }
            unsafe {
                CloseHandle(self.handle);
            }
            self.handle = null_mut();
        }
    }
}

fn image_for_handle(handle: HANDLE) -> Result<String, String> {
    let mut path = vec![0_u16; 32768];
    let mut length = path.len() as u32;
    if unsafe { QueryFullProcessImageNameW(handle, 0, path.as_mut_ptr(), &mut length) } == 0 {
        return Err(error("process image"));
    }
    Ok(String::from_utf16_lossy(&path[..length as usize]))
}

fn image_for_pid(pid: u32) -> String {
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        return String::new();
    }
    let image = image_for_handle(handle).unwrap_or_default();
    unsafe {
        CloseHandle(handle);
    }
    Path::new(&image)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

pub struct Job(HANDLE);

pub struct FileHold(HANDLE);

impl FileHold {
    pub fn deny_replacement(path: &Path) -> Result<Self, String> {
        let path = wide(path.as_os_str());
        let handle =
            unsafe { CreateFileW(path.as_ptr(), 0x80000000, 3, null(), 3, 0x80, null_mut()) };
        if handle == INVALID_HANDLE_VALUE {
            return Err(error("hold owned file without delete sharing"));
        }
        Ok(Self(handle))
    }
}

impl Drop for FileHold {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

impl Job {
    pub fn new(allow_breakaway: bool) -> Result<Self, String> {
        let handle = unsafe { CreateJobObjectW(null(), null()) };
        if handle.is_null() {
            return Err(error("create test job"));
        }
        let job = Self(handle);
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if allow_breakaway {
            limits.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_BREAKAWAY_OK;
        }
        if unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        } == 0
        {
            return Err(error("configure test job"));
        }
        Ok(job)
    }

    pub fn launch(
        &self,
        application: &Path,
        arguments: &str,
        cwd: &Path,
        environment: &mut [u16],
    ) -> Result<Process, String> {
        let application_wide = wide(application.as_os_str());
        let mut command_line = wide(format!("\"{}\" {arguments}", application.display()));
        let cwd_wide = wide(cwd.as_os_str());
        let mut bytes = 0_usize;
        unsafe {
            InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut bytes);
        }
        let mut storage = vec![0_u128; bytes.div_ceil(size_of::<u128>())];
        let attributes = storage.as_mut_ptr().cast();
        if unsafe { InitializeProcThreadAttributeList(attributes, 1, 0, &mut bytes) } == 0 {
            return Err(error("initialize job attribute"));
        }
        let handle = self.0;
        let updated = unsafe {
            UpdateProcThreadAttribute(
                attributes,
                0,
                PROC_THREAD_ATTRIBUTE_JOB_LIST as usize,
                (&handle as *const HANDLE).cast(),
                size_of::<HANDLE>(),
                null_mut(),
                null(),
            )
        };
        if updated == 0 {
            unsafe {
                DeleteProcThreadAttributeList(attributes);
            }
            return Err(error("set job attribute"));
        }
        let mut startup: STARTUPINFOEXW = unsafe { zeroed() };
        startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
        startup.lpAttributeList = attributes;
        let mut information: PROCESS_INFORMATION = unsafe { zeroed() };
        let created = unsafe {
            CreateProcessW(
                application_wide.as_ptr(),
                command_line.as_mut_ptr(),
                null(),
                null(),
                0,
                0x08080400,
                environment.as_ptr().cast(),
                cwd_wide.as_ptr(),
                &startup.StartupInfo,
                &mut information,
            )
        };
        let code = std::io::Error::last_os_error();
        unsafe {
            DeleteProcThreadAttributeList(attributes);
        }
        if created == 0 {
            return Err(format!(
                "create owned process: Windows code {}",
                code.raw_os_error().unwrap_or(0)
            ));
        }
        unsafe {
            CloseHandle(information.hThread);
        }
        Process::from_handle(information.hProcess, information.dwProcessId)
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

fn launch_environment(decoy: &Path, overrides: &[(&str, &str)]) -> Result<Vec<u16>, String> {
    let pointer = unsafe { GetEnvironmentStringsW() };
    if pointer.is_null() {
        return Err(error("read process environment"));
    }
    let mut entries = Vec::<String>::new();
    let mut offset = 0;
    unsafe {
        loop {
            let mut length = 0;
            while *pointer.add(offset + length) != 0 {
                length += 1;
            }
            if length == 0 {
                break;
            }
            entries.push(String::from_utf16_lossy(std::slice::from_raw_parts(
                pointer.add(offset),
                length,
            )));
            offset += length + 1;
        }
        FreeEnvironmentStringsW(pointer);
    }
    entries.retain(|entry| {
        if entry.starts_with('=') {
            return true;
        }
        let name = entry.split('=').next().unwrap_or("");
        !name.eq_ignore_ascii_case("USERPROFILE")
            && !name.eq_ignore_ascii_case("NODE_OPTIONS")
            && !name.eq_ignore_ascii_case("HOAI_SERVICE_NAMESPACE")
            && !overrides
                .iter()
                .any(|(key, _)| name.eq_ignore_ascii_case(key))
    });
    entries.push(format!("USERPROFILE={}", decoy.display()));
    for (key, value) in overrides {
        entries.push(format!("{key}={value}"));
    }
    entries.sort_by_key(|entry| entry.to_uppercase().encode_utf16().collect::<Vec<_>>());
    let mut environment = Vec::new();
    for entry in entries {
        environment.extend(entry.encode_utf16());
        environment.push(0);
    }
    environment.push(0);
    Ok(environment)
}

pub struct Fixture {
    pub root: PathBuf,
    pub home: PathBuf,
    pub decoy: PathBuf,
    pub watcher: PathBuf,
    pub state: PathBuf,
    pub config_path: PathBuf,
    pub config: Value,
    pub key_parent: String,
    pub binary: PathBuf,
    cleanup_baseline: u64,
}

impl Fixture {
    pub fn new(label: &str) -> Result<Self, String> {
        let id = format!(
            "{}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|e| e.to_string())?
                .as_nanos(),
            NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
        );
        let root = PathBuf::from(scratch())
            .join("runs")
            .join(format!("{label}-{id}"));
        let home = root.join("home");
        let decoy = root.join("decoy");
        let watcher = root.join("fake-watcher");
        let state = root.join("state");
        validate_launch_config(
            &LaunchSafety {
                home: home.to_string_lossy().into_owned(),
                node_path: node_image().to_owned(),
                watcher_dir: watcher.to_string_lossy().into_owned(),
                state_dir: state.to_string_lossy().into_owned(),
                fixture_root: root.to_string_lossy().into_owned(),
            },
            &real_profiles()?,
        )?;
        for directory in [
            &home.join("AppData").join("Local"),
            &decoy.join("AppData").join("Local"),
            &watcher.join("bin"),
            &state,
        ] {
            fs::create_dir_all(directory).map_err(|e| e.to_string())?;
        }
        let key_parent = format!(r"Software\HOAI-Test\glasshelper\{id}");
        let config = json!({"schema":1,"home":home,"nodePath":node_image(),"watcherDir":watcher,"namespace":"gh","stateDir":state,"testRunKey":format!("{key_parent}\\Run")});
        let fixture = Self {
            config_path: root.join("config.json"),
            root,
            home,
            decoy,
            watcher,
            state,
            config,
            key_parent,
            binary: helper_path(),
            cleanup_baseline: cleanup_failure_count(),
        };
        fixture.save_config()?;
        fs::write(fixture.script(), FAKE_WATCHER).map_err(|e| e.to_string())?;
        fixture.set_mode("wait")?;
        Ok(fixture)
    }

    pub fn script(&self) -> PathBuf {
        self.watcher.join("bin").join("hoai-watcher.mjs")
    }
    pub fn state_path(&self) -> PathBuf {
        self.state.join("helper-state.json")
    }
    pub fn log_path(&self) -> PathBuf {
        self.state.join("helper.log")
    }
    pub fn key(&self) -> String {
        format!("{}\\Run", self.key_parent)
    }

    pub fn save_config(&self) -> Result<(), String> {
        fs::write(
            &self.config_path,
            serde_json::to_vec(&self.config).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())
    }

    pub fn set_mode(&self, mode: &str) -> Result<(), String> {
        fs::write(self.watcher.join("bin").join("fixture-mode.txt"), mode)
            .map_err(|e| e.to_string())
    }

    pub fn validate_before_launch(&self, selected_config: &Path) -> Result<(), String> {
        let mut safety = LaunchSafety {
            home: self.home.to_string_lossy().into_owned(),
            node_path: node_image().to_owned(),
            watcher_dir: self.watcher.to_string_lossy().into_owned(),
            state_dir: self.state.to_string_lossy().into_owned(),
            fixture_root: self.root.to_string_lossy().into_owned(),
        };
        let profiles = real_profiles()?;
        validate_launch_config(&safety, &profiles)?;
        if let Ok(value) = fs::read(selected_config).and_then(|bytes| {
            serde_json::from_slice::<Value>(&bytes).map_err(std::io::Error::other)
        }) {
            for (field, destination) in [
                ("home", &mut safety.home),
                ("nodePath", &mut safety.node_path),
                ("watcherDir", &mut safety.watcher_dir),
                ("stateDir", &mut safety.state_dir),
            ] {
                if let Some(value) = value[field].as_str() {
                    *destination = value.to_owned();
                }
            }
            validate_launch_config(&safety, &profiles)?;
        }
        Ok(())
    }

    pub fn launch(
        &self,
        verb: &str,
        overrides: &[(&str, &str)],
        allow_breakaway: bool,
    ) -> Result<Run<'_>, String> {
        self.launch_selected(verb, Some(&self.config_path), overrides, allow_breakaway)
    }

    pub fn launch_without_config(
        &self,
        verb: &str,
        overrides: &[(&str, &str)],
    ) -> Result<Run<'_>, String> {
        self.launch_selected(verb, None, overrides, false)
    }

    pub fn launch_config_alias(&self, verb: &str, config: &Path) -> Result<Run<'_>, String> {
        self.launch_selected(verb, Some(config), &[], false)
    }

    fn launch_selected(
        &self,
        verb: &str,
        selected: Option<&Path>,
        overrides: &[(&str, &str)],
        allow_breakaway: bool,
    ) -> Result<Run<'_>, String> {
        if !["run", "register", "unregister"].contains(&verb) {
            return Err("unknown test CLI verb".to_owned());
        }
        let target = path_key(&target_dir()?)?;
        if self.binary.file_name().is_none_or(|name| {
            !name
                .to_string_lossy()
                .eq_ignore_ascii_case("hoai-helper.exe")
        }) || !same_or_under(&path_key(&self.binary.to_string_lossy())?, &target)
        {
            return Err("helper image must be the lane target executable".to_owned());
        }
        reject_reparse_ancestors(&self.binary)?;
        let selected_raw = selected.map(|path| path.to_string_lossy().into_owned());
        let selected_full = selected_raw.as_deref().map(full_path).transpose()?;
        if let (Some(raw), Some(full)) = (&selected_raw, &selected_full) {
            reject_reparse_ancestors(Path::new(full))?;
            if raw.contains('"')
                || raw.contains('\0')
                || raw.ends_with(['\\', '/'])
                || full.contains('"')
                || !Path::new(full).is_file()
                || path_key(full)? != path_key(&self.config_path.to_string_lossy())?
            {
                return Err("selected config is not the validated owned file".to_owned());
            }
        }
        let validation_path = selected_full
            .as_deref()
            .map(Path::new)
            .unwrap_or(&self.config_path);
        self.validate_before_launch(validation_path)?;
        let arguments = match selected_raw {
            Some(path) => format!("{verb} --config \"{path}\""),
            None => verb.to_owned(),
        };
        let mut environment = launch_environment(&self.decoy, overrides)?;
        let baseline_helpers = helper_snapshot()?;
        let job = Job::new(allow_breakaway)?;
        let started = Instant::now();
        let helper = job.launch(&self.binary, &arguments, &self.root, &mut environment)?;
        Ok(Run {
            fixture: self,
            helper,
            job: Some(job),
            tracked: Vec::new(),
            started,
            baseline_helpers,
        })
    }

    pub fn log(&self) -> String {
        fs::read_to_string(self.log_path()).unwrap_or_default()
    }
    pub fn read_state(&self) -> Option<Value> {
        fs::read(self.state_path())
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
    }

    pub fn create_registry_parent(&self, volatile: bool) -> Result<RegistryKey, String> {
        RegistryKey::create(&self.key_parent, volatile)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if self
            .key_parent
            .starts_with(r"Software\HOAI-Test\glasshelper\")
        {
            let key = wide(&self.key_parent);
            let tree_code = unsafe { RegDeleteTreeW(HKEY_CURRENT_USER, key.as_ptr()) };
            let key_code = unsafe { RegDeleteKeyW(HKEY_CURRENT_USER, key.as_ptr()) };
            for code in [tree_code, key_code] {
                if ![0, 2, 3].contains(&code) {
                    cleanup_failure(format!("CLEANUP_REGISTRY_FAILED code={code}"));
                }
            }
        }
        if !std::thread::panicking() {
            assert_eq!(
                cleanup_failure_count(),
                self.cleanup_baseline,
                "owned fixture cleanup failed"
            );
        }
    }
}

pub struct Run<'a> {
    pub fixture: &'a Fixture,
    pub helper: Process,
    pub job: Option<Job>,
    pub tracked: Vec<Process>,
    started: Instant,
    baseline_helpers: Vec<HelperIdentity>,
}

impl Run<'_> {
    pub fn wait_state(&mut self, predicate: impl Fn(&Value) -> bool) -> Result<Value, String> {
        while self.started.elapsed() < Duration::from_secs(30) {
            if let Some(value) = self.fixture.read_state() {
                if value["helperCreationTime"]
                    .as_str()
                    .and_then(|value| value.parse::<u64>().ok())
                    .is_none_or(|time| time < self.helper.creation)
                {
                    sleep(Duration::from_millis(2));
                    continue;
                }
                self.track_state(&value)?;
                if predicate(&value) && self.started.elapsed() < Duration::from_secs(30) {
                    return Ok(value);
                }
            }
            if !self.helper.running() && self.helper.exit_code(Duration::ZERO)? != 0 {
                return Err(format!(
                    "helper exited {} before required state",
                    self.helper.exit_code(Duration::ZERO)?
                ));
            }
            sleep(Duration::from_millis(2));
        }
        Err("INCONCLUSIVE: fake readiness exceeded 30 seconds".to_owned())
    }

    fn track_state(&mut self, value: &Value) -> Result<(), String> {
        if value["helperCreationTime"]
            .as_str()
            .and_then(|value| value.parse::<u64>().ok())
            .is_none_or(|time| time < self.helper.creation)
        {
            return Ok(());
        }
        for (pid_key, time_key, image) in [
            (
                "helperPid",
                "helperCreationTime",
                self.fixture.binary.as_path(),
            ),
            ("watcherPid", "watcherCreationTime", Path::new(node_image())),
        ] {
            if let (Some(pid), Some(time)) = (
                value[pid_key].as_u64(),
                value[time_key]
                    .as_str()
                    .and_then(|value| value.parse::<u64>().ok()),
            ) {
                if pid != 0
                    && pid != u64::from(self.helper.pid)
                    && !self
                        .tracked
                        .iter()
                        .any(|process| u64::from(process.pid) == pid && process.creation == time)
                {
                    self.tracked
                        .push(Process::open(pid as u32, Some(time), image)?);
                }
            }
        }
        Ok(())
    }

    pub fn adopt_state(&mut self, value: &Value) -> Result<(), String> {
        self.track_state(value)
    }

    pub fn observations(&mut self) -> Result<Vec<Value>, String> {
        let mut observations = Vec::new();
        for entry in fs::read_dir(self.fixture.watcher.join("bin")).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.starts_with("observed-") || !name.ends_with(".json") {
                continue;
            }
            let modified = entry
                .metadata()
                .map_err(|e| e.to_string())?
                .modified()
                .map_err(|e| e.to_string())?;
            let original_write = modified
                .duration_since(UNIX_EPOCH)
                .map_err(|e| e.to_string())?
                .as_nanos()
                / 100
                + 116_444_736_000_000_000;
            if original_write < u128::from(self.helper.creation) {
                continue;
            }
            let Ok(bytes) = fs::read(entry.path()) else {
                continue;
            };
            let Ok(mut value) = serde_json::from_slice::<Value>(&bytes) else {
                continue;
            };
            let Some(pid) = value["pid"].as_u64() else {
                continue;
            };
            if name != format!("observed-{pid}.json") {
                return Err("fake report filename/pid mismatch".to_owned());
            }
            if value["creationTime"]
                .as_str()
                .and_then(|value| value.parse::<u64>().ok())
                .is_some_and(|time| time < self.helper.creation)
            {
                continue;
            }
            let existing = self
                .tracked
                .iter()
                .find(|process| u64::from(process.pid) == pid);
            if existing.is_none() {
                let expected = value["creationTime"]
                    .as_str()
                    .and_then(|value| value.parse().ok())
                    .or_else(|| {
                        let state = self.fixture.read_state()?;
                        if state["helperCreationTime"].as_str()?.parse::<u64>().ok()?
                            < self.helper.creation
                        {
                            return None;
                        }
                        if state["watcherPid"].as_u64()? != pid {
                            return None;
                        }
                        state["watcherCreationTime"].as_str()?.parse().ok()
                    });
                let process = if let Some(expected) = expected {
                    Process::open(pid as u32, Some(expected), Path::new(node_image()))?
                } else {
                    Process::open_in_creation_range(
                        pid as u32,
                        self.helper.creation,
                        original_write as u64,
                        Path::new(node_image()),
                    )?
                };
                self.tracked.push(process);
            }
            let process = self
                .tracked
                .iter()
                .find(|process| u64::from(process.pid) == pid)
                .unwrap();
            let creation = process.creation.to_string();
            if value["creationTime"].as_str() != Some(creation.as_str()) {
                value["creationTime"] = Value::String(creation);
                fs::write(
                    entry.path(),
                    serde_json::to_vec(&value).map_err(|e| e.to_string())?,
                )
                .map_err(|e| e.to_string())?;
            }
            observations.push(value);
        }
        observations.sort_by_key(|value| {
            value["creationTime"]
                .as_str()
                .and_then(|text| text.parse::<u64>().ok())
                .unwrap_or(0)
        });
        Ok(observations)
    }

    pub fn wait_observations(&mut self, count: usize) -> Result<Vec<Value>, String> {
        loop {
            if self.started.elapsed() >= Duration::from_secs(30) {
                return Err(
                    "INCONCLUSIVE: fake readiness exceeded 30 seconds from launch".to_owned(),
                );
            }
            let observations = self.observations()?;
            if observations.len() >= count && self.started.elapsed() < Duration::from_secs(30) {
                return Ok(observations);
            }
            if !self.helper.running() && self.helper.exit_code(Duration::ZERO)? != 0 {
                return Err(format!(
                    "helper exited {} before fake report",
                    self.helper.exit_code(Duration::ZERO)?
                ));
            }
            sleep(Duration::from_millis(2));
        }
    }

    pub fn acknowledge(&self, pid: u32) -> Result<(), String> {
        fs::write(
            self.fixture.watcher.join("bin").join(format!("ack-{pid}")),
            b"exit",
        )
        .map_err(|e| e.to_string())
    }

    pub fn process(&self, pid: u32) -> &Process {
        self.tracked
            .iter()
            .find(|process| process.pid == pid)
            .expect("fake process handle retained")
    }

    pub fn sentinel(&self) -> Result<Process, String> {
        let job = self.job.as_ref().ok_or("job already closed")?;
        let script = self.fixture.watcher.join("bin").join("sentinel.mjs");
        fs::write(&script, "setInterval(() => {}, 1000);\n").map_err(|e| e.to_string())?;
        let mut environment = launch_environment(&self.fixture.decoy, &[])?;
        job.launch(
            Path::new(node_image()),
            &format!("\"{}\"", script.display()),
            &self.fixture.root,
            &mut environment,
        )
    }
}

impl Drop for Run<'_> {
    fn drop(&mut self) {
        if let Some(state) = self.fixture.read_state() {
            let _ = self.track_state(&state);
        }
        let _ = self.observations();
        let mut escaped_helpers = Vec::<Process>::new();
        let started = Instant::now();
        loop {
            if let Ok(helpers) = helper_snapshot() {
                for identity in helpers {
                    if identity.pid != self.helper.pid
                        && identity.creation >= self.helper.creation
                        && !self.baseline_helpers.iter().any(|prior| {
                            prior.pid == identity.pid && prior.creation == identity.creation
                        })
                        && !escaped_helpers.iter().any(|prior| {
                            prior.pid == identity.pid && prior.creation == identity.creation
                        })
                    {
                        if let Ok(process) =
                            Process::open(identity.pid, Some(identity.creation), &identity.path)
                        {
                            println!(
                                "HELPER_SWEEP pid={} name=hoai-helper.exe path={}",
                                identity.pid,
                                identity.path.display()
                            );
                            escaped_helpers.push(process);
                        }
                    }
                }
            } else {
                cleanup_failure("CLEANUP_HELPER_SNAPSHOT_FAILED".to_owned());
            }
            let mut parents = vec![&self.helper];
            parents.extend(escaped_helpers.iter());
            let known = self
                .tracked
                .iter()
                .filter(|process| process.running())
                .map(|process| process.pid)
                .collect::<BTreeSet<_>>();
            match capture_owned_node_children(&parents, &known, &self.fixture.root) {
                Ok(children) => self.tracked.extend(children),
                Err(problem) => cleanup_failure(format!("CLEANUP_CHILD_CAPTURE_FAILED {problem}")),
            }
            for parent in &parents {
                if let Err(problem) = parent.end() {
                    cleanup_failure(format!(
                        "PROCESS_CLEANUP_FAILED pid={} {problem}",
                        parent.pid
                    ));
                }
            }
            let known = self
                .tracked
                .iter()
                .filter(|process| process.running())
                .map(|process| process.pid)
                .collect::<BTreeSet<_>>();
            match capture_owned_node_children(&parents, &known, &self.fixture.root) {
                Ok(children) => self.tracked.extend(children),
                Err(problem) => cleanup_failure(format!("CLEANUP_CHILD_CAPTURE_FAILED {problem}")),
            }
            let remaining = match helper_snapshot() {
                Ok(helpers) => helpers
                    .into_iter()
                    .filter(|identity| {
                        identity.pid != self.helper.pid
                            && identity.creation >= self.helper.creation
                            && !self.baseline_helpers.iter().any(|prior| {
                                prior.pid == identity.pid && prior.creation == identity.creation
                            })
                            && !escaped_helpers.iter().any(|prior| {
                                prior.pid == identity.pid && prior.creation == identity.creation
                            })
                    })
                    .count(),
                Err(_) => {
                    cleanup_failure("CLEANUP_HELPER_SNAPSHOT_FAILED".to_owned());
                    1
                }
            };
            if remaining == 0 {
                break;
            }
            if started.elapsed() > Duration::from_secs(5) {
                cleanup_failure(format!(
                    "CLEANUP_HELPER_DISCOVERY_FAILED remaining={remaining}"
                ));
                break;
            }
        }
        let _ = self.observations();
        for process in &self.tracked {
            if let Err(problem) = process.end() {
                cleanup_failure(format!(
                    "PROCESS_CLEANUP_FAILED pid={} {problem}",
                    process.pid
                ));
            }
        }
        self.job.take();
    }
}

pub struct RegistryKey(HKEY);

impl RegistryKey {
    pub fn create(path: &str, volatile: bool) -> Result<Self, String> {
        if !path.starts_with(r"Software\HOAI-Test\glasshelper\") {
            return Err("test registry boundary refused".to_owned());
        }
        let path = wide(path);
        let mut handle = null_mut();
        let code = unsafe {
            RegCreateKeyExW(
                HKEY_CURRENT_USER,
                path.as_ptr(),
                0,
                null(),
                if volatile {
                    REG_OPTION_VOLATILE
                } else {
                    REG_OPTION_NON_VOLATILE
                },
                KEY_READ | KEY_WRITE,
                null(),
                &mut handle,
                null_mut(),
            )
        };
        if code != 0 {
            return Err(format!("test registry create code {code}"));
        }
        Ok(Self(handle))
    }

    pub fn open(path: &str) -> Result<Self, String> {
        if !path.starts_with(r"Software\HOAI-Test\glasshelper\") {
            return Err("test registry boundary refused".to_owned());
        }
        let mut handle = null_mut();
        let path = wide(path);
        let code = unsafe {
            RegOpenKeyExW(
                HKEY_CURRENT_USER,
                path.as_ptr(),
                0,
                KEY_READ | KEY_WRITE,
                &mut handle,
            )
        };
        if code != 0 {
            return Err(format!("test registry open code {code}"));
        }
        Ok(Self(handle))
    }

    pub fn set(&self, name: &str, value: &str) -> Result<(), String> {
        let name = wide(name);
        let value = wide(value);
        let code = unsafe {
            RegSetValueExW(
                self.0,
                name.as_ptr(),
                0,
                REG_SZ,
                value.as_ptr().cast(),
                (value.len() * 2) as u32,
            )
        };
        if code != 0 {
            return Err(format!("test registry value code {code}"));
        }
        Ok(())
    }

    pub fn values(&self) -> Result<BTreeMap<String, String>, String> {
        let mut values = BTreeMap::new();
        for index in 0.. {
            let mut name = vec![0_u16; 16384];
            let mut name_length = name.len() as u32;
            let mut data = vec![0_u16; 32768];
            let mut data_length = (data.len() * 2) as u32;
            let mut kind = 0;
            let code = unsafe {
                RegEnumValueW(
                    self.0,
                    index,
                    name.as_mut_ptr(),
                    &mut name_length,
                    null(),
                    &mut kind,
                    data.as_mut_ptr().cast(),
                    &mut data_length,
                )
            };
            if code == 259 {
                break;
            }
            if code != 0 {
                return Err(format!("test registry enumerate code {code}"));
            }
            if kind != REG_SZ {
                return Err("unexpected test registry type".to_owned());
            }
            let units = &data[..data_length as usize / 2];
            values.insert(
                String::from_utf16_lossy(&name[..name_length as usize]),
                String::from_utf16_lossy(units.strip_suffix(&[0]).unwrap_or(units)),
            );
        }
        Ok(values)
    }
}

impl Drop for RegistryKey {
    fn drop(&mut self) {
        unsafe {
            RegCloseKey(self.0);
        }
    }
}

#[derive(Clone, Debug)]
pub struct Desktop {
    pub foreground: usize,
    pub windows: BTreeMap<usize, (u32, String)>,
}

unsafe extern "system" fn collect_window(hwnd: HWND, context: LPARAM) -> i32 {
    if unsafe { IsWindowVisible(hwnd) } == 0 {
        return 1;
    }
    let mut pid = 0;
    unsafe {
        GetWindowThreadProcessId(hwnd, &mut pid);
    }
    let windows = unsafe { &mut *(context as *mut BTreeMap<usize, (u32, String)>) };
    windows.insert(hwnd as usize, (pid, image_for_pid(pid)));
    1
}

impl Desktop {
    pub fn capture() -> Result<Self, String> {
        let mut windows = BTreeMap::new();
        if unsafe {
            EnumWindows(
                Some(collect_window),
                (&mut windows as *mut BTreeMap<usize, (u32, String)>) as LPARAM,
            )
        } == 0
        {
            return Err(error("enumerate desktop windows"));
        }
        Ok(Self {
            foreground: unsafe { GetForegroundWindow() } as usize,
            windows,
        })
    }

    /// This desktop with a foreground no window has. Opens nothing.
    pub fn with_false_foreground(mut self) -> Self {
        self.foreground = usize::MAX;
        self
    }

    /// The processes that own a visible window right now. Opens nothing.
    pub fn window_owners(&self) -> BTreeSet<u32> {
        self.windows.values().map(|(pid, _)| *pid).collect()
    }

    pub fn check(&self, owned: &BTreeSet<u32>) -> Result<(), String> {
        let current = Self::capture()?;
        if current.foreground != self.foreground {
            let mut pid = 0;
            unsafe {
                GetWindowThreadProcessId(current.foreground as _, &mut pid);
            }
            return Err(format!(
                "FAIL: foreground changed hwnd={} pid={pid} name={}",
                current.foreground,
                image_for_pid(pid)
            ));
        }
        let mut foreign = None;
        for (hwnd, (pid, name)) in &current.windows {
            if owned.contains(pid) {
                return Err(format!(
                    "FAIL: owned visible window hwnd={hwnd} pid={pid} name={name}"
                ));
            }
            if !self.windows.contains_key(hwnd) {
                if ["conhost.exe", "openconsole.exe", "windowsterminal.exe"]
                    .iter()
                    .any(|candidate| name.eq_ignore_ascii_case(candidate))
                {
                    return Err(format!(
                        "FAIL: terminal-family window hwnd={hwnd} pid={pid} name={name}"
                    ));
                }
                foreign.get_or_insert_with(|| {
                    format!("INCONCLUSIVE: foreign new window hwnd={hwnd} pid={pid} name={name}")
                });
            }
        }
        foreign.map_or(Ok(()), Err)
    }
}

pub struct FocusMonitor {
    owned: Arc<Mutex<BTreeSet<u32>>>,
    ready: Arc<Mutex<Option<Instant>>>,
    stop: Arc<std::sync::atomic::AtomicBool>,
    observations: Arc<Mutex<(Vec<Instant>, Option<String>)>>,
    thread: Option<std::thread::JoinHandle<()>>,
    foreground: usize,
}

impl FocusMonitor {
    pub fn start() -> Result<Self, String> {
        let baseline = Desktop::capture()?;
        for (hwnd, (pid, name)) in &baseline.windows {
            println!("WINDOW_BASELINE hwnd={hwnd} pid={pid} name={name}");
        }
        let foreground = baseline.foreground;
        println!("FOREGROUND_BASELINE hwnd={foreground}");
        if baseline.windows.is_empty() {
            return Err("inconclusive: this desktop shows no visible window".to_owned());
        }
        let owned = Arc::new(Mutex::new(BTreeSet::new()));
        let ready = Arc::new(Mutex::new(None));
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let observations = Arc::new(Mutex::new((Vec::new(), None)));
        let thread_owned = Arc::clone(&owned);
        let thread_stop = Arc::clone(&stop);
        let thread_observations = Arc::clone(&observations);
        let thread = std::thread::spawn(move || {
            let started = Instant::now();
            while !thread_stop.load(Ordering::Relaxed)
                && started.elapsed() < Duration::from_secs(45)
            {
                let sample = Instant::now();
                let result = baseline.check(&thread_owned.lock().expect("owned set lock"));
                let mut state = thread_observations.lock().expect("sample lock");
                state.0.push(sample);
                if let Err(problem) = result {
                    if state.1.is_none() || problem.starts_with("FAIL:") {
                        state.1 = Some(problem);
                    }
                }
                drop(state);
                sleep(Duration::from_millis(10));
            }
        });
        Ok(Self {
            owned,
            ready,
            stop,
            observations,
            thread: Some(thread),
            foreground,
        })
    }

    pub fn add(&self, pid: u32) {
        self.owned.lock().expect("owned set lock").insert(pid);
    }
    pub fn mark_ready(&self) {
        *self.ready.lock().expect("ready lock") = Some(Instant::now());
    }

    pub fn finish(mut self) -> Result<(), String> {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            thread.join().map_err(|_| "desktop sampler panicked")?;
        }
        let ready = self
            .ready
            .lock()
            .map_err(|_| "ready lock poisoned")?
            .ok_or("sampler never marked ready")?;
        let state = self
            .observations
            .lock()
            .map_err(|_| "sample lock poisoned")?;
        if let Some(problem) = &state.1 {
            return Err(problem.clone());
        }
        let samples: Vec<_> = state
            .0
            .iter()
            .copied()
            .filter(|sample| {
                *sample >= ready && sample.duration_since(ready) < Duration::from_secs(10)
            })
            .collect();
        let mut buckets = [0_usize; 10];
        let mut max_gap = Duration::ZERO;
        let mut previous = ready;
        for sample in &samples {
            buckets[sample.duration_since(ready).as_secs() as usize] += 1;
            max_gap = max_gap.max(sample.duration_since(previous));
            previous = *sample;
        }
        max_gap =
            max_gap.max((ready + Duration::from_secs(10)).saturating_duration_since(previous));
        println!(
            "FOCUS samples={} buckets={buckets:?} maxGapMs={:.3}",
            samples.len(),
            max_gap.as_secs_f64() * 1000.0
        );
        if buckets.iter().any(|count| *count < 20) || max_gap > Duration::from_millis(100) {
            return Err("INCONCLUSIVE: desktop sampling cadence below requirement".to_owned());
        }
        // A NULL foreground on both sides proves nothing about focus, so it is never a pass.
        // The window half above has still run and passed by this point.
        if self.foreground == 0 {
            return Err(
                "INCONCLUSIVE: no foreground window on this desktop, focus half not observed"
                    .to_owned(),
            );
        }
        Ok(())
    }
}

impl Drop for FocusMonitor {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// What a recorded pid means when this user may not query the process or read its image.
/// Pids get reused, so a recorded one can now belong to anything on the machine.
/// This lane starts only helpers and node, so another name is not this lane's.
/// Those two names stay a failure: a refusal cannot tell whose they are.
pub fn refused_record_identity(
    pid: u32,
    name: Option<&str>,
) -> Result<Option<(u64, String, bool)>, String> {
    let Some(name) = name else {
        return Ok(None);
    };
    if name.eq_ignore_ascii_case("node.exe") || name.eq_ignore_ascii_case("hoai-helper.exe") {
        return Err(format!(
            "recorded pid {pid} refuses reading under the name {name}"
        ));
    }
    println!("OWNED_RECORD_REFUSED pid={pid} name={name} result=not-this-lane");
    Ok(None)
}

fn snapshot_name(pid: u32) -> Result<Option<String>, String> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(error("recorded process snapshot"));
    }
    let mut entry: PROCESSENTRY32W = unsafe { zeroed() };
    entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
    let mut next = unsafe { Process32FirstW(snapshot, &mut entry) };
    let mut name = None;
    while next != 0 {
        if entry.th32ProcessID == pid {
            let length = entry
                .szExeFile
                .iter()
                .position(|unit| *unit == 0)
                .unwrap_or(entry.szExeFile.len());
            name = Some(String::from_utf16_lossy(&entry.szExeFile[..length]));
            break;
        }
        next = unsafe { Process32NextW(snapshot, &mut entry) };
    }
    unsafe {
        CloseHandle(snapshot);
    }
    Ok(name)
}

pub fn query_process_identity(pid: u32) -> Result<Option<(u64, String, bool)>, String> {
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | 0x00100000, 0, pid) };
    if handle.is_null() {
        let code = std::io::Error::last_os_error().raw_os_error();
        if code == Some(87) {
            return Ok(None);
        }
        if code == Some(5) {
            return refused_record_identity(pid, snapshot_name(pid)?.as_deref());
        }
        return Err(error("read recorded process identity"));
    }
    let result = (|| {
        // An exited process that something still holds open keeps its pid. It is no
        // leftover, and it can no longer name its image.
        if unsafe { WaitForSingleObject(handle, 0) } != WAIT_TIMEOUT {
            return Ok(None);
        }
        let path = match image_for_handle(handle) {
            Ok(path) => path,
            // A live process can grant the query and still refuse its image name.
            // That is a refused reading too, so the process list names it.
            Err(problem) if problem == "process image: Windows code 5" => {
                return refused_record_identity(pid, snapshot_name(pid)?.as_deref());
            }
            Err(problem) => return Err(problem),
        };
        let mut created = unsafe { zeroed() };
        let mut exited = unsafe { zeroed() };
        let mut kernel = unsafe { zeroed() };
        let mut user = unsafe { zeroed() };
        if unsafe { GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) }
            == 0
        {
            return Err(error("read recorded process creation"));
        }
        Ok(Some((
            filetime(created),
            path,
            unsafe { WaitForSingleObject(handle, 0) } == WAIT_TIMEOUT,
        )))
    })();
    unsafe {
        CloseHandle(handle);
    }
    result
}

fn node_record_files() -> Result<Vec<PathBuf>, String> {
    let root = PathBuf::from(scratch()).join("runs");
    reject_reparse_ancestors(&root)?;
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut pending = vec![root];
    let mut records = Vec::new();
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(directory).map_err(|problem| problem.to_string())? {
            let entry = entry.map_err(|problem| problem.to_string())?;
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path).map_err(|problem| problem.to_string())?;
            if metadata.file_attributes() & 0x400 != 0 {
                println!(
                    "OWNED_RECORD_LINK_SKIPPED path={} result=not-followed",
                    path.display()
                );
                continue;
            }
            if metadata.is_dir() {
                pending.push(path);
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if metadata.is_file()
                && (name == "helper-state.json"
                    || (name.starts_with("observed-") && name.ends_with(".json"))
                    || (name.starts_with("cleanup-identity-node-") && name.ends_with(".json")))
            {
                records.push(path);
            }
        }
    }
    records.sort();
    Ok(records)
}

type NodeRecords = (BTreeSet<(u32, u64)>, Vec<(u32, u64, PathBuf)>);

fn recorded_nodes() -> Result<NodeRecords, String> {
    let mut complete = BTreeSet::new();
    let mut incomplete = Vec::new();
    for path in node_record_files()? {
        let bytes = fs::read(&path).map_err(|problem| problem.to_string())?;
        let value: Value = serde_json::from_slice(&bytes)
            .map_err(|_| format!("invalid owned process record at {}", path.display()))?;
        let name = path.file_name().unwrap().to_string_lossy();
        let (pid_value, creation_value) = if name == "helper-state.json" {
            (&value["watcherPid"], &value["watcherCreationTime"])
        } else {
            if name.starts_with("cleanup-identity-node-") {
                if value["kind"] != "native-cleanup-identity"
                    || value["image"]
                        .as_str()
                        .is_none_or(|image| path_key(image).ok() != path_key(node_image()).ok())
                {
                    return Err(format!(
                        "invalid native cleanup record at {}",
                        path.display()
                    ));
                }
            }
            (&value["pid"], &value["creationTime"])
        };
        let Some(pid) = pid_value
            .as_u64()
            .and_then(|pid| u32::try_from(pid).ok())
            .filter(|pid| *pid != 0)
        else {
            continue;
        };
        if let Some(creation) = creation_value
            .as_str()
            .and_then(|value| value.parse::<u64>().ok())
            .filter(|creation| *creation != 0)
        {
            complete.insert((pid, creation));
        } else {
            let modified = fs::symlink_metadata(&path)
                .and_then(|metadata| metadata.modified())
                .map_err(|problem| problem.to_string())?;
            let upper = modified
                .duration_since(UNIX_EPOCH)
                .map_err(|problem| problem.to_string())?
                .as_nanos()
                / 100
                + 116_444_736_000_000_000;
            incomplete.push((
                pid,
                u64::try_from(upper).map_err(|problem| problem.to_string())?,
                path,
            ));
        }
    }
    Ok((complete, incomplete))
}

pub fn final_owned_process_sweep() -> Result<(), String> {
    let unique = format!(
        "{}-{}-{}",
        std::process::id(),
        current_filetime()?,
        NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
    );
    let cleanup_root = PathBuf::from(scratch())
        .join("runs")
        .join(format!("final-sweep-{unique}"));
    reject_reparse_ancestors(&cleanup_root)?;
    fs::create_dir_all(&cleanup_root).map_err(|problem| problem.to_string())?;
    let mut helpers = Vec::<Process>::new();
    let mut children = Vec::<Process>::new();
    let started = Instant::now();
    loop {
        for identity in helper_snapshot_inner(true)? {
            if helpers
                .iter()
                .any(|process| process.pid == identity.pid && process.creation == identity.creation)
            {
                continue;
            }
            match Process::open(identity.pid, Some(identity.creation), &identity.path) {
                Ok(process) => helpers.push(process),
                Err(problem)
                    if problem.contains("identity mismatch")
                        || problem.contains("Windows code 87") => {}
                Err(problem) => return Err(problem),
            }
        }
        let parents = helpers.iter().collect::<Vec<_>>();
        let known = children
            .iter()
            .filter(|process| process.running())
            .map(|process| process.pid)
            .collect::<BTreeSet<_>>();
        children.extend(capture_owned_node_children(
            &parents,
            &known,
            &cleanup_root,
        )?);
        for helper in &helpers {
            if helper.running() {
                println!(
                    "OWNED_PROCESS_SWEEP pid={} name=hoai-helper.exe path={} result=ending",
                    helper.pid,
                    helper.image()?
                );
                helper.end()?;
            }
        }
        let known = children
            .iter()
            .filter(|process| process.running())
            .map(|process| process.pid)
            .collect::<BTreeSet<_>>();
        children.extend(capture_owned_node_children(
            &parents,
            &known,
            &cleanup_root,
        )?);
        let pending = helper_snapshot_inner(true)?.into_iter().any(|identity| {
            !helpers
                .iter()
                .any(|process| process.pid == identity.pid && process.creation == identity.creation)
        });
        if !pending {
            break;
        }
        if started.elapsed() >= Duration::from_secs(5) {
            return Err("helper discovery exceeded final sweep deadline".to_owned());
        }
    }
    for child in &children {
        if child.running() {
            println!(
                "OWNED_PROCESS_SWEEP pid={} name=node.exe path={node} result=ending",
                child.pid,
                node = node_image()
            );
            child.end()?;
        }
    }
    let (records, _) = recorded_nodes()?;
    for (pid, creation) in records {
        let Some((actual_creation, image, running)) = query_process_identity(pid)? else {
            continue;
        };
        if actual_creation != creation || path_key(&image)? != path_key(node_image())? || !running {
            continue;
        }
        let process = match Process::open(pid, Some(creation), Path::new(node_image())) {
            Ok(process) => process,
            Err(problem)
                if problem.contains("identity mismatch") || problem.contains("Windows code 87") =>
            {
                continue
            }
            Err(problem) => return Err(problem),
        };
        println!(
            "OWNED_PROCESS_SWEEP pid={pid} name=node.exe path={node} result=ending",
            node = node_image()
        );
        process.end()?;
    }

    // This second readback uses non-terminating handles and cannot make itself pass.
    for identity in helper_snapshot_inner(true)? {
        if let Some((creation, image, running)) = query_process_identity(identity.pid)? {
            if running
                && creation == identity.creation
                && path_key(&image)? == path_key(&identity.path.to_string_lossy())?
            {
                return Err("target helper remains after final sweep".to_owned());
            }
        }
    }
    let (records, incomplete) = recorded_nodes()?;
    for (pid, creation) in records {
        if let Some((actual_creation, image, running)) = query_process_identity(pid)? {
            if actual_creation == creation
                && path_key(&image)? == path_key(node_image())?
                && running
            {
                println!("OWNED_PROCESS_READBACK pid={pid} name=node.exe path={node} result=still-running", node = node_image());
                return Err("recorded node remains after final sweep".to_owned());
            }
        }
    }
    for (pid, original_write, source) in incomplete {
        if let Some((creation, image, running)) = query_process_identity(pid)? {
            if running && creation <= original_write && path_key(&image)? == path_key(node_image())?
            {
                println!("OWNED_PROCESS_READBACK pid={pid} name=node.exe path={node} result=unverified-record", node = node_image());
                return Err(format!(
                    "live reported node has no exact creation record at {}",
                    source.display()
                ));
            }
        }
    }
    if cleanup_failure_count() != 0 {
        return Err("cleanup failure counter is nonzero".to_owned());
    }
    println!("OWNED_PROCESS_SWEEP result=clean helpers=0 matchingNodes=0");
    Ok(())
}

const FAKE_WATCHER: &str = r#"import fs from 'node:fs';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
const here = new URL('.', import.meta.url);
const mode = fs.readFileSync(new URL('fixture-mode.txt', here), 'utf8');
const keys = Object.keys(process.env);
const nsKey = keys.find(key => key.toLowerCase() === 'hoai_service_namespace');
const report = {pid:process.pid, args:process.argv.slice(1), cwd:process.cwd(), home:os.homedir(), nodeOptionsPresent:keys.some(key => key.toLowerCase() === 'node_options'), namespace:nsKey === undefined ? null : process.env[nsKey], stdoutIsTTY:process.stdout.isTTY ?? null, script:fileURLToPath(import.meta.url)};
fs.writeFileSync(new URL(`observed-${process.pid}.json`, here), JSON.stringify(report));
if (mode === 'ack-exit') {
  const timer = setInterval(() => {
    if (fs.existsSync(new URL(`ack-${process.pid}`, here))) { clearInterval(timer); process.exit(0); }
  }, 1);
} else {
  setInterval(() => {}, 1000);
}
"#;
