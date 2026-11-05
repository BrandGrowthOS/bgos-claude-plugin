use std::io;
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Storage::FileSystem::GetFullPathNameW;
use windows_sys::Win32::System::Environment::{FreeEnvironmentStringsW, GetEnvironmentStringsW};

pub struct OwnedHandle(HANDLE);

impl OwnedHandle {
    /// # Safety
    /// The caller transfers ownership of this handle, and must not close it again.
    pub unsafe fn from_raw(handle: HANDLE) -> Self {
        Self(handle)
    }

    pub fn as_raw(&self) -> HANDLE {
        self.0
    }
}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
            unsafe { CloseHandle(self.0) };
        }
    }
}

pub fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

pub fn full_path(value: &str) -> io::Result<String> {
    if value.contains('\0') {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "path contains NUL",
        ));
    }
    let input = wide(value);
    let mut output = vec![0_u16; 260];
    loop {
        let length = unsafe {
            GetFullPathNameW(
                input.as_ptr(),
                output.len() as u32,
                output.as_mut_ptr(),
                std::ptr::null_mut(),
            )
        };
        if length == 0 {
            return Err(io::Error::last_os_error());
        }
        if (length as usize) < output.len() {
            return String::from_utf16(&output[..length as usize]).map_err(|_| {
                io::Error::new(io::ErrorKind::InvalidData, "path contains invalid UTF-16")
            });
        }
        output.resize(length as usize + 1, 0);
    }
}

pub fn inherited_environment() -> io::Result<Vec<(String, String)>> {
    struct Environment(*mut u16);
    impl Drop for Environment {
        fn drop(&mut self) {
            unsafe { FreeEnvironmentStringsW(self.0) };
        }
    }
    let environment = Environment(unsafe { GetEnvironmentStringsW() });
    if environment.0.is_null() {
        return Err(io::Error::last_os_error());
    }
    let mut entries = Vec::new();
    let mut cursor = environment.0;
    // Windows returns a double-NUL-terminated, process-owned snapshot, released
    // by the Environment guard.
    unsafe {
        while *cursor != 0 {
            let start = cursor;
            while *cursor != 0 {
                cursor = cursor.add(1);
            }
            let units = std::slice::from_raw_parts(start, cursor.offset_from(start) as usize);
            // One entry that cannot be represented must not stop the watcher starting.
            if let Some(entry) = decode_environment_entry(units) {
                entries.push(entry);
            }
            cursor = cursor.add(1);
        }
    }
    Ok(entries)
}

/// One environment entry as a name and value. None when it cannot be represented.
pub fn decode_environment_entry(units: &[u16]) -> Option<(String, String)> {
    let text = String::from_utf16(units).ok()?;
    // Per-drive entries begin with '=', so their separator is the second '='.
    // Preserve that leading character in the name.
    let search_start = usize::from(text.starts_with('='));
    let separator = text[search_start..].find('=')? + search_start;
    Some((text[..separator].into(), text[separator + 1..].into()))
}
