#[cfg(unix)]
fn main() {
    gateway_native::native_request_process::run_native_request();
}
#[cfg(not(unix))]
fn main() {
    std::process::exit(78);
}
