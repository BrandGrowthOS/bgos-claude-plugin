#![windows_subsystem = "windows"]

mod logging;
mod runtime;
mod state;

fn main() {
    let hardening = runtime::harden();
    std::process::exit(runtime::entry(hardening));
}
