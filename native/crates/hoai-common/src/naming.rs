use std::io;
use std::ptr::{null, null_mut};
use windows_sys::Win32::Security::Cryptography::{
    BCryptCloseAlgorithmProvider, BCryptCreateHash, BCryptDestroyHash, BCryptFinishHash,
    BCryptGetProperty, BCryptHashData, BCryptOpenAlgorithmProvider, BCRYPT_ALG_HANDLE,
    BCRYPT_HASH_HANDLE, BCRYPT_HASH_LENGTH, BCRYPT_OBJECT_LENGTH, BCRYPT_SHA256_ALGORITHM,
};

fn javascript_whitespace(value: char) -> bool {
    matches!(value, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}'
        | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}'
        | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

pub fn canonical_home(value: &str) -> String {
    let value = value.trim_matches(javascript_whitespace).replace('/', "\\");
    if value.is_empty() {
        return String::new();
    }
    let bytes = value.as_bytes();
    let mut root_end = 0;
    let mut absolute = false;
    let mut device = String::new();
    if bytes[0] == b'\\' {
        absolute = true;
        root_end = 1;
        // Node's win32 normalization recognizes a server and share as one
        // device. Parent components cannot climb above that share.
        if bytes.len() > 1 && bytes[1] == b'\\' {
            let mut cursor = 2;
            let server_start = cursor;
            while cursor < bytes.len() && bytes[cursor] != b'\\' {
                cursor += 1;
            }
            if cursor > server_start && cursor < bytes.len() {
                let server_end = cursor;
                while cursor < bytes.len() && bytes[cursor] == b'\\' {
                    cursor += 1;
                }
                let share_start = cursor;
                while cursor < bytes.len() && bytes[cursor] != b'\\' {
                    cursor += 1;
                }
                if cursor > share_start {
                    device = format!(
                        "\\\\{}\\{}",
                        &value[server_start..server_end],
                        &value[share_start..cursor]
                    );
                    root_end = cursor;
                }
            }
        }
    } else if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        device.push_str(&value[..2]);
        root_end = 2;
        if bytes.len() > 2 && bytes[2] == b'\\' {
            absolute = true;
            root_end = 3;
        }
    }
    let mut parts = Vec::new();
    for part in value[root_end..].split('\\') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.last().is_some_and(|last| *last != "..") {
                    parts.pop();
                } else if !absolute {
                    parts.push(part);
                }
            }
            _ => parts.push(part),
        }
    }
    let tail = parts.join("\\");
    let mut result = if absolute {
        format!("{device}\\{tail}")
    } else if tail.is_empty() {
        format!("{device}.")
    } else {
        format!("{device}{tail}")
    };
    result.truncate(result.trim_end_matches('\\').len());
    if result.len() == 2
        && result.as_bytes()[0].is_ascii_alphabetic()
        && result.as_bytes()[1] == b':'
    {
        result.push('\\');
    }
    result.to_lowercase()
}

fn cng_result(status: i32) -> io::Result<()> {
    if status < 0 {
        Err(io::Error::from_raw_os_error(status))
    } else {
        Ok(())
    }
}

struct Algorithm(BCRYPT_ALG_HANDLE);

impl Drop for Algorithm {
    fn drop(&mut self) {
        unsafe { BCryptCloseAlgorithmProvider(self.0, 0) };
    }
}

struct Hash(BCRYPT_HASH_HANDLE);

impl Drop for Hash {
    fn drop(&mut self) {
        unsafe { BCryptDestroyHash(self.0) };
    }
}

fn property_u32(algorithm: BCRYPT_ALG_HANDLE, property: *const u16) -> io::Result<u32> {
    let mut value = 0_u32;
    let mut written = 0;
    cng_result(unsafe {
        BCryptGetProperty(
            algorithm,
            property,
            (&mut value as *mut u32).cast(),
            4,
            &mut written,
            0,
        )
    })?;
    if written != 4 {
        return Err(io::Error::other("CNG property size"));
    }
    Ok(value)
}

pub fn sha256_hex(bytes: &[u8]) -> io::Result<String> {
    let mut raw_algorithm = null_mut();
    cng_result(unsafe {
        BCryptOpenAlgorithmProvider(&mut raw_algorithm, BCRYPT_SHA256_ALGORITHM, null(), 0)
    })?;
    let algorithm = Algorithm(raw_algorithm);
    let object_length = property_u32(algorithm.0, BCRYPT_OBJECT_LENGTH)?;
    let hash_length = property_u32(algorithm.0, BCRYPT_HASH_LENGTH)?;
    if hash_length != 32 {
        return Err(io::Error::other("CNG SHA-256 size"));
    }
    let mut object = vec![0_u8; object_length as usize];
    let mut raw_hash = null_mut();
    cng_result(unsafe {
        BCryptCreateHash(
            algorithm.0,
            &mut raw_hash,
            object.as_mut_ptr(),
            object_length,
            null(),
            0,
            0,
        )
    })?;
    let hash = Hash(raw_hash);
    for chunk in bytes.chunks(u32::MAX as usize) {
        cng_result(unsafe { BCryptHashData(hash.0, chunk.as_ptr(), chunk.len() as u32, 0) })?;
    }
    let mut digest = [0_u8; 32];
    cng_result(unsafe { BCryptFinishHash(hash.0, digest.as_mut_ptr(), hash_length, 0) })?;
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(64);
    for byte in digest {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 15) as usize] as char);
    }
    Ok(output)
}

pub fn home_id(home: &str) -> io::Result<String> {
    Ok(sha256_hex(canonical_home(home).as_bytes())?[..8].to_owned())
}

pub fn helper_value_name(home: &str, namespace: Option<&str>) -> io::Result<String> {
    let namespace = namespace
        .map(|value| format!(" ({value})"))
        .unwrap_or_default();
    Ok(format!("HOAI Helper{namespace} home-{}", home_id(home)?))
}

pub fn mutex_name(sid: &str, full_config_path: &str) -> io::Result<String> {
    let digest = sha256_hex(canonical_home(full_config_path).as_bytes())?;
    Ok(format!("Local\\HOAI-Helper-{sid}-{}", &digest[..16]))
}
