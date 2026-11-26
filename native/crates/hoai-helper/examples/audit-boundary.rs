#![windows_subsystem = "windows"]

#[path = "../tests/support/mod.rs"]
mod support;

use std::fs;
use std::path::PathBuf;
use std::ptr::{null, null_mut};
use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_NO_MORE_ITEMS};
use windows_sys::Win32::System::Registry::{
    RegCloseKey, RegDeleteKeyW, RegEnumValueW, RegOpenKeyExW, RegQueryInfoKeyW, HKEY_CURRENT_USER,
    KEY_QUERY_VALUE,
};

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}

fn names() -> std::io::Result<Vec<String>> {
    let key_name = wide("Software\\Microsoft\\Windows\\CurrentVersion\\Run");
    let mut key = null_mut();
    let status = unsafe {
        RegOpenKeyExW(
            HKEY_CURRENT_USER,
            key_name.as_ptr(),
            0,
            KEY_QUERY_VALUE,
            &mut key,
        )
    };
    if status == ERROR_FILE_NOT_FOUND {
        return Ok(Vec::new());
    }
    if status != 0 {
        return Err(std::io::Error::from_raw_os_error(status as i32));
    }
    let result = (|| {
        let mut values = Vec::new();
        for index in 0.. {
            let mut buffer = vec![0u16; 32768];
            let mut size = buffer.len() as u32;
            // Deliberately query no value data or data length.
            let status = unsafe {
                RegEnumValueW(
                    key,
                    index,
                    buffer.as_mut_ptr(),
                    &mut size,
                    null(),
                    null_mut(),
                    null_mut(),
                    null_mut(),
                )
            };
            if status == ERROR_NO_MORE_ITEMS {
                break;
            }
            if status != 0 {
                return Err(std::io::Error::from_raw_os_error(status as i32));
            }
            values.push(String::from_utf16(&buffer[..size as usize]).map_err(|_| {
                std::io::Error::new(std::io::ErrorKind::InvalidData, "invalid UTF-16 value name")
            })?);
        }
        values.sort();
        Ok(values)
    })();
    unsafe {
        RegCloseKey(key);
    }
    result
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mode = std::env::args()
        .nth(1)
        .ok_or("begin or end required, then the evidence folder")?;
    if !["begin", "end"].contains(&mode.as_str()) {
        return Err("begin or end required".into());
    }
    if mode == "end" {
        support::final_owned_process_sweep().map_err(std::io::Error::other)?;
    }
    // The folder that keeps the before and after snapshots is named by the caller.
    let root = PathBuf::from(std::env::args().nth(2).ok_or("evidence folder required")?);
    let names = names()?;
    let digest = hoai_common::naming::sha256_hex(names.join("\n").as_bytes())?;
    if digest.len() != 64 {
        return Err("SHA-256 implementation is required before a boundary run".into());
    }
    let snapshot = serde_json::json!({"names": names, "count": names.len(), "sha256": digest});
    let before = root.join("registry-before.json");
    match mode.as_str() {
        "begin" => {
            if before.exists() {
                let old: serde_json::Value = serde_json::from_slice(&fs::read(&before)?)?;
                if old != snapshot {
                    return Err("registry names differ from retained baseline".into());
                }
            } else {
                fs::write(&before, serde_json::to_vec_pretty(&snapshot)?)?;
            }
            println!("SAFE-3 BEGIN names={} sha256={}", names.len(), digest);
        }
        "end" => {
            let old: serde_json::Value = serde_json::from_slice(&fs::read(&before)?)?;
            fs::write(
                root.join("registry-after.json"),
                serde_json::to_vec_pretty(&snapshot)?,
            )?;
            if old != snapshot {
                return Err("registry value names changed; stop and report".into());
            }
            // Our own subtree must be empty by now; a key left behind is a failed clean-up.
            // The shared parent is removed only if nothing else lives there.
            if !remove_empty_parent("Software\\HOAI-Test\\glasshelper")? {
                return Err("Software\\HOAI-Test\\glasshelper still has test keys".into());
            }
            remove_empty_parent("Software\\HOAI-Test")?;
            println!(
                "SAFE-3 PASS names={} sha256={} unchanged",
                names.len(),
                digest
            );
        }
        _ => return Err("begin or end required".into()),
    }
    Ok(())
}

/// True when the key is gone afterwards, false when it still holds something.
fn remove_empty_parent(path: &str) -> std::io::Result<bool> {
    let name = wide(path);
    let mut key = null_mut();
    let status = unsafe {
        RegOpenKeyExW(
            HKEY_CURRENT_USER,
            name.as_ptr(),
            0,
            KEY_QUERY_VALUE,
            &mut key,
        )
    };
    if status == ERROR_FILE_NOT_FOUND {
        return Ok(true);
    }
    if status != 0 {
        return Err(std::io::Error::from_raw_os_error(status as i32));
    }
    let mut subkeys = 0;
    let mut values = 0;
    let status = unsafe {
        RegQueryInfoKeyW(
            key,
            null_mut(),
            null_mut(),
            null(),
            &mut subkeys,
            null_mut(),
            null_mut(),
            &mut values,
            null_mut(),
            null_mut(),
            null_mut(),
            null_mut(),
        )
    };
    unsafe {
        RegCloseKey(key);
    }
    if status != 0 {
        return Err(std::io::Error::from_raw_os_error(status as i32));
    }
    if subkeys == 0 && values == 0 {
        let status = unsafe { RegDeleteKeyW(HKEY_CURRENT_USER, name.as_ptr()) };
        if status != 0 && status != ERROR_FILE_NOT_FOUND {
            return Err(std::io::Error::from_raw_os_error(status as i32));
        }
        return Ok(true);
    }
    Ok(false)
}

fn main() {
    if let Err(error) = run() {
        eprintln!("audit-boundary failed: {error}");
        std::process::exit(1);
    }
}
