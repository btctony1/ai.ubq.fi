#[cfg(unix)]
fn main() {
    gateway_native::existing_account_import::import_process::run_native_import()
}
#[cfg(not(unix))]
fn main() {
    std::process::exit(78)
}
