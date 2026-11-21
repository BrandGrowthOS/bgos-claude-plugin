use std::env;
use std::fs;
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::Command;

// D11: replace this one placeholder when the certificate's legal name is known.
const COMPANY_NAME: &str = "HOAI";

fn main() {
    let manifest = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("manifest directory"));
    let package = manifest.join("../../../package.json");
    println!("cargo:rerun-if-changed={}", package.display());
    println!("cargo:rerun-if-changed=build.rs");
    let json: serde_json::Value =
        serde_json::from_slice(&fs::read(&package).expect("package.json"))
            .expect("valid package.json");
    let version = json["version"].as_str().expect("plugin version");
    let numbers: Vec<u16> = version
        .split('.')
        .map(|v| v.parse().expect("numeric plugin version"))
        .collect();
    assert_eq!(
        numbers.len(),
        3,
        "plugin version must have three components"
    );
    let version_words = format!("{},{},{},0", numbers[0], numbers[1], numbers[2]);
    let kits =
        PathBuf::from(env::var_os("ProgramFiles(x86)").expect("Windows SDK ProgramFiles(x86)"))
            .join("Windows Kits/10/bin");
    let mut candidates: Vec<(Vec<u32>, PathBuf)> = fs::read_dir(&kits)
        .expect("installed Windows SDK directory")
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let parts: Option<Vec<u32>> = name.split('.').map(|p| p.parse().ok()).collect();
            let path = entry.path().join("x64/rc.exe");
            parts.filter(|_| path.is_file()).map(|parts| (parts, path))
        })
        .collect();
    candidates.sort_by(|a, b| a.0.cmp(&b.0));
    let compiler = &candidates
        .last()
        .expect("no installed x64 Windows SDK rc.exe found")
        .1;
    let out = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR"));
    let source = out.join("hoai-version.rc");
    let resource = out.join("hoai-version.res");
    let text = format!(
        "1 VERSIONINFO\nFILEVERSION {version_words}\nPRODUCTVERSION {version_words}\nFILEFLAGSMASK 0x3fL\nFILEFLAGS 0x0L\nFILEOS 0x40004L\nFILETYPE 0x1L\nFILESUBTYPE 0x0L\nBEGIN\n BLOCK \"StringFileInfo\"\n BEGIN\n  BLOCK \"040904B0\"\n  BEGIN\n   VALUE \"ProductName\", \"HOAI\\0\"\n   VALUE \"FileDescription\", \"HOAI helper\\0\"\n   VALUE \"CompanyName\", \"{COMPANY_NAME}\\0\"\n   VALUE \"FileVersion\", \"{version}\\0\"\n   VALUE \"ProductVersion\", \"{version}\\0\"\n  END\n END\n BLOCK \"VarFileInfo\"\n BEGIN\n  VALUE \"Translation\", 0x409, 1200\n END\nEND\n"
    );
    fs::write(&source, text).expect("write version resource under OUT_DIR");
    let status = Command::new(compiler)
        .arg("/nologo")
        .arg("/fo")
        .arg(&resource)
        .arg(&source)
        .creation_flags(0x08000000)
        .env("TMP", &out)
        .env("TEMP", &out)
        .current_dir(&out)
        .status()
        .expect("run installed rc.exe");
    assert!(status.success(), "rc.exe failed");
    println!(
        "cargo:rustc-link-arg-bin=hoai-helper={}",
        resource.display()
    );
}
