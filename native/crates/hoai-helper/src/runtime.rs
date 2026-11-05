use crate::logging::Logger;
use crate::state::{self, HelperState};
use hoai_common::win32::{full_path, inherited_environment, wide, OwnedHandle};
use hoai_common::{
    build_launch_plan, config_log_directory, environment_block, helper_value_name, mutex_name,
    next_failure_count, parse_config, restart_delay, validate_drive_path, validate_test_run_key,
    Config,
};
use std::fs;
use std::io;
use std::mem::{size_of, zeroed};
use std::path::{Path, PathBuf};
use std::ptr::{null, null_mut};
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{
    GetLastError, LocalFree, SetLastError, ERROR_ALREADY_EXISTS, ERROR_FILE_NOT_FOUND,
    ERROR_PATH_NOT_FOUND, FILETIME, HANDLE, WAIT_OBJECT_0,
};
use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
use windows_sys::Win32::Security::{GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER};
use windows_sys::Win32::Storage::FileSystem::{
    GetFileAttributesW, FILE_ATTRIBUTE_DIRECTORY, INVALID_FILE_ATTRIBUTES,
};
use windows_sys::Win32::System::Diagnostics::Debug::{SetThreadErrorMode, SEM_FAILCRITICALERRORS};
use windows_sys::Win32::System::Environment::{GetCommandLineW, GetCurrentDirectoryW};
use windows_sys::Win32::System::JobObjects::IsProcessInJob;
use windows_sys::Win32::System::LibraryLoader::{
    GetModuleFileNameW, SetDefaultDllDirectories, LOAD_LIBRARY_SEARCH_SYSTEM32,
};
use windows_sys::Win32::System::Registry::{
    RegCloseKey, RegCreateKeyExW, RegDeleteValueW, RegOpenKeyExW, RegSetValueExW, HKEY,
    HKEY_CURRENT_USER, KEY_SET_VALUE, REG_OPTION_NON_VOLATILE, REG_SZ,
};
use windows_sys::Win32::System::Threading::{
    CreateMutexW, CreateProcessW, GetCurrentProcess, GetCurrentProcessId, GetExitCodeProcess,
    GetProcessTimes, OpenProcessToken, ProcessImageLoadPolicy, SetProcessMitigationPolicy,
    TerminateProcess, WaitForSingleObject, CREATE_BREAKAWAY_FROM_JOB, INFINITE,
    PROCESS_INFORMATION, STARTUPINFOW,
};

fn last_code() -> u32 {
    unsafe { GetLastError() }
}

fn io_code(error: &io::Error) -> u32 {
    error.raw_os_error().map(|code| code as u32).unwrap_or(31)
}

pub fn harden() -> Result<(), u32> {
    if unsafe { SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32) } == 0 {
        return Err(last_code());
    }
    let image_policy = 7_u32;
    if unsafe {
        SetProcessMitigationPolicy(
            ProcessImageLoadPolicy,
            (&image_policy as *const u32).cast(),
            size_of::<u32>(),
        )
    } == 0
    {
        return Err(last_code());
    }
    Ok(())
}

struct Arguments {
    verb: String,
    config_path: String,
}

fn arguments() -> Result<Arguments, ()> {
    let values: Vec<String> = std::env::args_os()
        .skip(1)
        .map(|value| value.into_string().map_err(|_| ()))
        .collect::<Result<_, _>>()?;
    if values.len() != 3
        || !matches!(values[0].as_str(), "run" | "register" | "unregister")
        || values[1] != "--config"
        || values[2].contains(['"', '\0'])
        || values[2].ends_with(['\\', '/'])
    {
        return Err(());
    }
    let config_path = full_path(&values[2]).map_err(|_| ())?;
    if !validate_drive_path(&config_path)
        || config_path.contains('"')
        || config_path.ends_with(['\\', '/'])
        || !Path::new(&config_path).is_file()
    {
        return Err(());
    }
    Ok(Arguments {
        verb: values[0].clone(),
        config_path,
    })
}

pub fn entry(mut hardening: Result<(), u32>) -> i32 {
    // This is thread-local so the watcher does not receive a changed process
    // error mode. It precedes configuration and all path checks.
    if unsafe { SetThreadErrorMode(SEM_FAILCRITICALERRORS, null_mut()) } == 0 && hardening.is_ok() {
        hardening = Err(last_code());
    }
    let arguments = match arguments() {
        Ok(arguments) => arguments,
        Err(()) => return if hardening.is_err() { 1 } else { 10 },
    };
    let bytes = match fs::read(&arguments.config_path) {
        Ok(bytes) => bytes,
        Err(_) => return if hardening.is_err() { 1 } else { 10 },
    };
    if let Err(code) = hardening {
        if let Some(directory) = config_log_directory(&bytes) {
            let _ = Logger::new(&directory).record(code, None, None);
        }
        return 1;
    }
    let config = match parse_config(&bytes) {
        Ok(config) => config,
        Err(_) => {
            if let Some(directory) = config_log_directory(&bytes) {
                let _ = Logger::new(&directory).record(10, None, None);
            }
            return 10;
        }
    };
    if arguments.verb == "run" {
        supervise(config, &arguments.config_path)
    } else {
        registration(
            &config,
            &arguments.config_path,
            arguments.verb == "register",
        )
    }
}

fn current_image() -> Result<String, u32> {
    let mut buffer = vec![0_u16; 260];
    loop {
        let length =
            unsafe { GetModuleFileNameW(null_mut(), buffer.as_mut_ptr(), buffer.len() as u32) };
        if length == 0 {
            return Err(last_code());
        }
        if (length as usize) < buffer.len() {
            return String::from_utf16(&buffer[..length as usize]).map_err(|_| 1113);
        }
        buffer.resize(buffer.len() * 2, 0);
    }
}

fn current_directory() -> Result<Vec<u16>, u32> {
    let mut buffer = vec![0_u16; 260];
    loop {
        let length = unsafe { GetCurrentDirectoryW(buffer.len() as u32, buffer.as_mut_ptr()) };
        if length == 0 {
            return Err(last_code());
        }
        if (length as usize) < buffer.len() {
            buffer.truncate(length as usize + 1);
            return Ok(buffer);
        }
        buffer.resize(length as usize + 1, 0);
    }
}

fn current_sid() -> Result<String, u32> {
    let mut token = null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(last_code());
    }
    let token = unsafe { OwnedHandle::from_raw(token) };
    let mut length = 0_u32;
    unsafe { GetTokenInformation(token.as_raw(), TokenUser, null_mut(), 0, &mut length) };
    if length == 0 {
        return Err(last_code());
    }
    // TOKEN_USER contains a pointer and needs pointer-aligned storage.
    let mut storage = vec![0_usize; (length as usize).div_ceil(size_of::<usize>())];
    if unsafe {
        GetTokenInformation(
            token.as_raw(),
            TokenUser,
            storage.as_mut_ptr().cast(),
            length,
            &mut length,
        )
    } == 0
    {
        return Err(last_code());
    }
    let user = unsafe { &*storage.as_ptr().cast::<TOKEN_USER>() };
    let mut text = null_mut();
    if unsafe { ConvertSidToStringSidW(user.User.Sid, &mut text) } == 0 {
        return Err(last_code());
    }
    let mut length = 0;
    unsafe {
        while *text.add(length) != 0 {
            length += 1;
        }
    }
    let result =
        String::from_utf16(unsafe { std::slice::from_raw_parts(text, length) }).map_err(|_| 1113);
    unsafe { LocalFree(text.cast()) };
    result
}

enum MutexFailure {
    Exists,
    Native(u32),
}

fn acquire_mutex(config_path: &str) -> Result<OwnedHandle, MutexFailure> {
    let sid = current_sid().map_err(MutexFailure::Native)?;
    let name =
        mutex_name(&sid, config_path).map_err(|error| MutexFailure::Native(io_code(&error)))?;
    let name = wide(&name);
    unsafe { SetLastError(0) };
    let handle = unsafe { CreateMutexW(null(), 0, name.as_ptr()) };
    let code = last_code();
    if handle.is_null() {
        return Err(MutexFailure::Native(code));
    }
    let owned = unsafe { OwnedHandle::from_raw(handle) };
    if code == ERROR_ALREADY_EXISTS {
        return Err(MutexFailure::Exists);
    }
    Ok(owned)
}

fn mutex_failure(failure: MutexFailure, logger: &Logger) -> i32 {
    match failure {
        MutexFailure::Exists => 12,
        MutexFailure::Native(code) => {
            let _ = logger.record(code, None, None);
            1
        }
    }
}

fn relaunch_outside_job() -> Result<u32, u32> {
    let application = wide(&current_image()?);
    let directory = current_directory()?;
    let original = unsafe { GetCommandLineW() };
    if original.is_null() {
        return Err(87);
    }
    let mut length = 0;
    unsafe {
        while *original.add(length) != 0 {
            length += 1;
        }
    }
    let mut command = unsafe { std::slice::from_raw_parts(original, length + 1) }.to_vec();
    let mut startup: STARTUPINFOW = unsafe { zeroed() };
    startup.cb = size_of::<STARTUPINFOW>() as u32;
    let mut child: PROCESS_INFORMATION = unsafe { zeroed() };
    if unsafe {
        CreateProcessW(
            application.as_ptr(),
            command.as_mut_ptr(),
            null(),
            null(),
            0,
            CREATE_BREAKAWAY_FROM_JOB,
            null(),
            directory.as_ptr(),
            &startup,
            &mut child,
        )
    } == 0
    {
        return Err(last_code());
    }
    let _process = unsafe { OwnedHandle::from_raw(child.hProcess) };
    let _thread = unsafe { OwnedHandle::from_raw(child.hThread) };
    Ok(child.dwProcessId)
}

fn ticks(time: FILETIME) -> u64 {
    (u64::from(time.dwHighDateTime) << 32) | u64::from(time.dwLowDateTime)
}

fn process_times(handle: HANDLE) -> Result<(u64, u64), u32> {
    let mut creation = unsafe { zeroed() };
    let mut exit = unsafe { zeroed() };
    let mut kernel = unsafe { zeroed() };
    let mut user = unsafe { zeroed() };
    if unsafe { GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) } == 0 {
        return Err(last_code());
    }
    Ok((ticks(creation), ticks(exit)))
}

fn watcher_script(config: &Config) -> PathBuf {
    PathBuf::from(format!(
        "{}\\bin\\hoai-watcher.mjs",
        config.watcher_dir.trim_end_matches(['\\', '/'])
    ))
}

fn check_required_paths(config: &Config) -> Result<(), (PathBuf, u32)> {
    for (path, directory) in [
        (PathBuf::from(&config.node_path), false),
        (PathBuf::from(&config.watcher_dir), true),
        (watcher_script(config), false),
    ] {
        let name = wide(&path.to_string_lossy());
        let attributes = unsafe { GetFileAttributesW(name.as_ptr()) };
        if attributes == INVALID_FILE_ATTRIBUTES {
            return Err((path, last_code()));
        }
        if (attributes & FILE_ATTRIBUTE_DIRECTORY != 0) != directory {
            return Err((path, 267));
        }
    }
    Ok(())
}

struct Watcher {
    process: OwnedHandle,
    pid: u32,
    creation: u64,
}

fn start_watcher(config: &Config) -> Result<Watcher, u32> {
    let inherited = inherited_environment().map_err(|error| io_code(&error))?;
    let plan = build_launch_plan(config, &inherited);
    let application = wide(&plan.application);
    let mut command = wide(&plan.command_line);
    let directory = wide(&plan.current_directory);
    let environment = environment_block(&plan.environment);
    let mut startup: STARTUPINFOW = unsafe { zeroed() };
    startup.cb = size_of::<STARTUPINFOW>() as u32;
    let mut child: PROCESS_INFORMATION = unsafe { zeroed() };
    if unsafe {
        CreateProcessW(
            application.as_ptr(),
            command.as_mut_ptr(),
            null(),
            null(),
            i32::from(plan.inherit_handles),
            plan.flags,
            environment.as_ptr().cast(),
            directory.as_ptr(),
            &startup,
            &mut child,
        )
    } == 0
    {
        return Err(last_code());
    }
    let process = unsafe { OwnedHandle::from_raw(child.hProcess) };
    let _thread = unsafe { OwnedHandle::from_raw(child.hThread) };
    let (creation, _) = match process_times(process.as_raw()) {
        Ok(times) => times,
        Err(code) => {
            // This handle comes directly from this call's successful spawn.
            // Do not leave an unrecorded watcher if its identity cannot be read.
            if unsafe { TerminateProcess(process.as_raw(), 1) } != 0 {
                unsafe { WaitForSingleObject(process.as_raw(), INFINITE) };
            }
            return Err(code);
        }
    };
    Ok(Watcher {
        process,
        pid: child.dwProcessId,
        creation,
    })
}

fn publish_supervision(directory: &Path, current: &HelperState, logger: &Logger) -> io::Result<()> {
    if let Err(error) = state::publish(directory, current) {
        let _ = logger.record(
            io_code(&error),
            Some(&directory.join("helper-state.json")),
            None,
        );
        return Err(error);
    }
    Ok(())
}

fn record_failure(
    current: &mut HelperState,
    code: u32,
    path: Option<&Path>,
    logger: &Logger,
) -> io::Result<()> {
    current.last_error_code = code;
    current.last_error_path = path.map(|path| path.to_string_lossy().into_owned());
    logger.record(code, path, None)
}

fn supervise(config: Config, config_path: &str) -> i32 {
    let directory = Path::new(&config.state_dir);
    let logger = Logger::new(directory);
    let mutex = match acquire_mutex(config_path) {
        Ok(mutex) => mutex,
        Err(failure) => return mutex_failure(failure, &logger),
    };
    let mut in_job = 0;
    if unsafe { IsProcessInJob(GetCurrentProcess(), null_mut(), &mut in_job) } == 0 {
        let _ = logger.record(last_code(), None, None);
        return 1;
    }
    let (mutex, job_result, job_error) = if in_job != 0 {
        drop(mutex);
        match relaunch_outside_job() {
            Ok(pid) => {
                return if logger.record(0, None, Some(pid)).is_ok() {
                    0
                } else {
                    1
                };
            }
            Err(code) => {
                let mutex = match acquire_mutex(config_path) {
                    Ok(mutex) => mutex,
                    Err(failure) => return mutex_failure(failure, &logger),
                };
                (mutex, "breakaway refused", code)
            }
        }
    } else {
        (mutex, "not in job", 0)
    };
    let _mutex = mutex;
    let pid = unsafe { GetCurrentProcessId() };
    let creation = match process_times(unsafe { GetCurrentProcess() }) {
        Ok((creation, _)) => creation,
        Err(code) => {
            let _ = logger.record(code, None, None);
            return 1;
        }
    };
    let mut current = HelperState::new(pid, creation, job_result, job_error);
    let mut initial = true;
    let mut has_started = false;
    let mut failures = 0_u32;
    loop {
        let paths = check_required_paths(&config);
        if initial {
            let (code, path) = match &paths {
                Ok(()) => (0, Path::new(config_path)),
                Err((path, code)) => (*code, path.as_path()),
            };
            current.last_error_code = code;
            current.last_error_path = paths
                .as_ref()
                .err()
                .map(|(path, _)| path.to_string_lossy().into_owned());
            if logger.record(code, Some(path), None).is_err() {
                return 1;
            }
            if let Err(error) = state::publish(directory, &current) {
                let _ = logger.record(
                    io_code(&error),
                    Some(&directory.join("helper-state.json")),
                    None,
                );
                return 1;
            }
            if paths.is_err() {
                return 11;
            }
            initial = false;
        }
        let mut uptime = 0_u64;
        match paths.and_then(|()| {
            start_watcher(&config).map_err(|code| (PathBuf::from(&config.node_path), code))
        }) {
            Err((path, code)) => {
                let recorded = record_failure(&mut current, code, Some(&path), &logger);
                let published = publish_supervision(directory, &current, &logger);
                if !has_started && (recorded.is_err() || published.is_err()) {
                    return 1;
                }
            }
            Ok(watcher) => {
                let started = Instant::now();
                has_started = true;
                current.watcher_pid = watcher.pid;
                current.watcher_creation_time = watcher.creation.to_string();
                current.last_error_code = 0;
                current.last_error_path = None;
                let _ = publish_supervision(directory, &current, &logger);
                let _ = logger.record(0, Some(Path::new(&config.node_path)), None);
                if unsafe { WaitForSingleObject(watcher.process.as_raw(), INFINITE) }
                    != WAIT_OBJECT_0
                {
                    let _ = record_failure(&mut current, last_code(), None, &logger);
                    let _ = publish_supervision(directory, &current, &logger);
                    return 1;
                }
                let mut exit_code = 0;
                if unsafe { GetExitCodeProcess(watcher.process.as_raw(), &mut exit_code) } == 0 {
                    exit_code = last_code();
                }
                uptime = started.elapsed().as_secs();
                current.watcher_pid = 0;
                current.watcher_creation_time = "0".into();
                let _ = record_failure(&mut current, exit_code, None, &logger);
                let _ = publish_supervision(directory, &current, &logger);
            }
        }
        let delay: Duration = restart_delay(failures, uptime);
        failures = next_failure_count(failures, uptime);
        std::thread::sleep(delay);
        current.restart_count = current.restart_count.saturating_add(1);
    }
}

struct RegistryKey(HKEY);

impl Drop for RegistryKey {
    fn drop(&mut self) {
        unsafe { RegCloseKey(self.0) };
    }
}

fn registration_key(config: &Config) -> Result<&str, i32> {
    if let Some(key) = &config.test_run_key {
        return if validate_test_run_key(key) {
            Ok(key)
        } else {
            Err(14)
        };
    }
    #[cfg(feature = "real-run-key")]
    {
        Ok("Software\\Microsoft\\Windows\\CurrentVersion\\Run")
    }
    #[cfg(not(feature = "real-run-key"))]
    {
        Err(14)
    }
}

fn registration(config: &Config, config_path: &str, register: bool) -> i32 {
    // Refuse an absent or invalid test destination before any registry API.
    let key = match registration_key(config) {
        Ok(key) => wide(key),
        Err(code) => return code,
    };
    let logger = Logger::new(Path::new(&config.state_dir));
    let name = match helper_value_name(&config.home, config.namespace.as_deref()) {
        Ok(name) => wide(&name),
        Err(error) => {
            let _ = logger.record(io_code(&error), None, None);
            return 1;
        }
    };
    let mut raw_key = null_mut();
    let result = if register {
        unsafe {
            RegCreateKeyExW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                0,
                null(),
                REG_OPTION_NON_VOLATILE,
                KEY_SET_VALUE,
                null(),
                &mut raw_key,
                null_mut(),
            )
        }
    } else {
        unsafe {
            RegOpenKeyExW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                0,
                KEY_SET_VALUE,
                &mut raw_key,
            )
        }
    };
    if !register && matches!(result, ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND) {
        return 0;
    }
    if result != 0 {
        let _ = logger.record(result, None, None);
        return 13;
    }
    let key = RegistryKey(raw_key);
    let result = if register {
        let image = match current_image() {
            Ok(image) => image,
            Err(code) => {
                let _ = logger.record(code, None, None);
                return 1;
            }
        };
        let command = wide(&format!("\"{image}\" run --config \"{config_path}\""));
        unsafe {
            RegSetValueExW(
                key.0,
                name.as_ptr(),
                0,
                REG_SZ,
                command.as_ptr().cast(),
                (command.len() * 2) as u32,
            )
        }
    } else {
        unsafe { RegDeleteValueW(key.0, name.as_ptr()) }
    };
    if result == 0 || (!register && result == ERROR_FILE_NOT_FOUND) {
        0
    } else {
        let _ = logger.record(result, None, None);
        13
    }
}
