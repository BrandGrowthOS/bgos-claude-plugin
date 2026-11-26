#![cfg(windows)]

// Layout references: learn.microsoft.com/en-us/windows/win32/debug/pe-format
// and learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-image_load_config_directory64.

use std::ffi::{c_void, OsStr};
use std::fs;
use std::os::windows::ffi::OsStrExt;
use std::path::PathBuf;
use std::ptr::null_mut;
use windows_sys::Win32::Storage::FileSystem::{
    GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW, VS_FIXEDFILEINFO,
};

fn release_path() -> PathBuf {
    // CARGO_TARGET_DIR when set; otherwise the target folder two levels above the built helper.
    let target = std::env::var_os("CARGO_TARGET_DIR").map_or_else(
        || {
            PathBuf::from(env!("CARGO_BIN_EXE_hoai-helper"))
                .ancestors()
                .nth(2)
                .expect("target folder above the built helper")
                .to_path_buf()
        },
        PathBuf::from,
    );
    let path = target.join("release").join("hoai-helper.exe");
    assert!(
        path.is_file(),
        "release artifact is required at {}",
        path.display()
    );
    path
}

fn read_u16(bytes: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes(
        bytes
            .get(offset..offset + 2)
            .expect("PE u16 in range")
            .try_into()
            .unwrap(),
    )
}

fn read_u32(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(
        bytes
            .get(offset..offset + 4)
            .expect("PE u32 in range")
            .try_into()
            .unwrap(),
    )
}

struct PeImage {
    bytes: Vec<u8>,
    optional: usize,
    sections: usize,
    section_count: usize,
}

impl PeImage {
    fn load() -> Self {
        let path = release_path();
        let bytes = fs::read(path).expect("release executable readable");
        assert_eq!(bytes.get(..2), Some(b"MZ".as_slice()), "DOS signature");
        let pe = read_u32(&bytes, 0x3c) as usize;
        assert_eq!(
            bytes.get(pe..pe + 4),
            Some(b"PE\0\0".as_slice()),
            "PE signature"
        );
        let optional = pe + 24;
        assert_eq!(read_u16(&bytes, optional), 0x20b, "PE32+ required");
        let section_count = read_u16(&bytes, pe + 6) as usize;
        let sections = optional + read_u16(&bytes, pe + 20) as usize;
        Self {
            bytes,
            optional,
            sections,
            section_count,
        }
    }

    fn offset(&self, rva: u32) -> usize {
        let headers_size = read_u32(&self.bytes, self.optional + 60);
        if rva < headers_size {
            return rva as usize;
        }
        for i in 0..self.section_count {
            let section = self.sections + 40 * i;
            let size = read_u32(&self.bytes, section + 8).max(read_u32(&self.bytes, section + 16));
            let start = read_u32(&self.bytes, section + 12);
            if rva >= start && rva - start < size {
                return (read_u32(&self.bytes, section + 20) + rva - start) as usize;
            }
        }
        panic!("PE RVA {rva:#x} is not mapped");
    }

    fn directory(&self, index: usize) -> (u32, u32) {
        let offset = self.optional + 112 + index * 8;
        (
            read_u32(&self.bytes, offset),
            read_u32(&self.bytes, offset + 4),
        )
    }

    fn string(&self, rva: u32) -> String {
        let start = self.offset(rva);
        let end = self.bytes[start..]
            .iter()
            .position(|byte| *byte == 0)
            .expect("PE string terminates")
            + start;
        String::from_utf8(self.bytes[start..end].to_vec()).expect("ASCII PE import name")
    }

    fn imports(&self) -> Vec<String> {
        let (rva, size) = self.directory(1);
        assert!(rva != 0 && size >= 20, "import directory required");
        let base = self.offset(rva);
        let mut imports = Vec::new();
        for index in 0..(size as usize / 20) {
            let descriptor = base + index * 20;
            let name = read_u32(&self.bytes, descriptor + 12);
            if name == 0 {
                break;
            }
            imports.push(self.string(name));
        }
        assert!(!imports.is_empty(), "import table cannot be empty");
        imports
    }
}

#[test]
#[ignore = "needs the C2 release build"]
fn release_has_gui_subsystem() {
    let pe = PeImage::load();
    let subsystem = read_u16(&pe.bytes, pe.optional + 68);
    println!("PE subsystem={subsystem}");
    assert_eq!(subsystem, 2, "Windows GUI subsystem required");
}

#[test]
#[ignore = "needs the C2 release build"]
fn release_imports_and_dependent_load_flag() {
    let pe = PeImage::load();
    let system = PathBuf::from(std::env::var_os("SystemRoot").expect("SystemRoot is required"))
        .join("System32");
    for import in pe.imports() {
        println!("PE import={import}");
        let name = import.to_ascii_lowercase();
        assert!(
            !["vcruntime", "msvcp", "ucrtbase", "api-ms-win-crt-"]
                .iter()
                .any(|prefix| name.starts_with(prefix)),
            "dynamic CRT import {import}"
        );
        assert!(
            name.starts_with("api-ms-win-core-")
                || name.starts_with("ext-ms-")
                || system.join(&import).is_file(),
            "non-system import {import}"
        );
    }
    let (rva, size) = pe.directory(10);
    assert!(
        rva != 0 && size >= 80,
        "load configuration with dependent flags is required"
    );
    let offset = pe.offset(rva);
    assert!(read_u32(&pe.bytes, offset) >= 80, "load configuration size");
    let flags = read_u16(&pe.bytes, offset + 78);
    println!("PE dependentLoadFlags={flags:#x}");
    assert_eq!(flags, 0x800, "system-only dependent loading required");
}

fn wide(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(Some(0)).collect()
}

fn query_version_string(data: &[u8], language: u16, codepage: u16, name: &str) -> String {
    let query = wide(OsStr::new(&format!(
        "\\StringFileInfo\\{language:04x}{codepage:04x}\\{name}"
    )));
    let mut result: *mut c_void = null_mut();
    let mut length = 0;
    assert_ne!(
        unsafe {
            VerQueryValueW(
                data.as_ptr().cast(),
                query.as_ptr(),
                &mut result,
                &mut length,
            )
        },
        0,
        "version string {name} is present"
    );
    assert!(
        !result.is_null() && length > 0,
        "version string {name} is nonempty"
    );
    let units = unsafe { std::slice::from_raw_parts(result.cast::<u16>(), length as usize) };
    String::from_utf16(units.strip_suffix(&[0]).unwrap_or(units))
        .expect("valid UTF-16 version string")
}

#[test]
#[ignore = "needs the C2 release build"]
fn release_version_resource_matches_plugin() {
    let path = release_path();
    let path_wide = wide(path.as_os_str());
    let size = unsafe { GetFileVersionInfoSizeW(path_wide.as_ptr(), null_mut()) };
    assert!(size > 0, "version resource exists");
    let mut data = vec![0_u8; size as usize];
    assert_ne!(
        unsafe { GetFileVersionInfoW(path_wide.as_ptr(), 0, size, data.as_mut_ptr().cast()) },
        0,
        "version resource reads"
    );
    let query = wide(OsStr::new("\\VarFileInfo\\Translation"));
    let mut translation: *mut c_void = null_mut();
    let mut length = 0;
    assert_ne!(
        unsafe {
            VerQueryValueW(
                data.as_ptr().cast(),
                query.as_ptr(),
                &mut translation,
                &mut length,
            )
        },
        0,
        "version translations exist"
    );
    assert!(
        length >= 4 && !translation.is_null(),
        "translation pair exists"
    );
    let pair = unsafe { std::slice::from_raw_parts(translation.cast::<u16>(), 2) };
    let package_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../package.json");
    let package: serde_json::Value =
        serde_json::from_slice(&fs::read(package_path).expect("plugin package is readable"))
            .expect("plugin package JSON");
    let version = package["version"].as_str().expect("plugin version");
    let components: Vec<u16> = version
        .split('.')
        .map(|component| {
            component
                .parse()
                .expect("numeric 16-bit package version component")
        })
        .collect();
    assert_eq!(
        components.len(),
        3,
        "three package version components are required"
    );
    let expected_ms = (u32::from(components[0]) << 16) | u32::from(components[1]);
    let expected_ls = u32::from(components[2]) << 16;
    let fixed_query = wide(OsStr::new("\\"));
    let mut fixed_pointer: *mut c_void = null_mut();
    let mut fixed_length = 0;
    assert_ne!(
        unsafe {
            VerQueryValueW(
                data.as_ptr().cast(),
                fixed_query.as_ptr(),
                &mut fixed_pointer,
                &mut fixed_length,
            )
        },
        0,
        "fixed version resource exists"
    );
    assert!(
        !fixed_pointer.is_null()
            && fixed_length as usize >= std::mem::size_of::<VS_FIXEDFILEINFO>(),
        "fixed version structure is complete"
    );
    let fixed = unsafe { std::ptr::read_unaligned(fixed_pointer.cast::<VS_FIXEDFILEINFO>()) };
    assert_eq!(fixed.dwSignature, 0xfeef04bd, "fixed version signature");
    println!(
        "PE fixedFileVersion={:#010x}/{:#010x} fixedProductVersion={:#010x}/{:#010x}",
        fixed.dwFileVersionMS,
        fixed.dwFileVersionLS,
        fixed.dwProductVersionMS,
        fixed.dwProductVersionLS
    );
    assert_eq!(
        (fixed.dwFileVersionMS, fixed.dwFileVersionLS),
        (expected_ms, expected_ls),
        "fixed file version matches package version and revision zero"
    );
    assert_eq!(
        (fixed.dwProductVersionMS, fixed.dwProductVersionLS),
        (expected_ms, expected_ls),
        "fixed product version matches package version and revision zero"
    );
    for (key, expected) in [
        ("ProductName", "HOAI"),
        ("FileDescription", "HOAI helper"),
        ("CompanyName", "HOAI"),
        ("FileVersion", version),
        ("ProductVersion", version),
    ] {
        let actual = query_version_string(&data, pair[0], pair[1], key);
        println!("PE {key}={actual}");
        assert_eq!(actual, expected, "resource {key}");
    }
}
