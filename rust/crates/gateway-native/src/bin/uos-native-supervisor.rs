#[cfg(unix)]
fn main() {
    gateway_native::connector_supervisor::run_native_supervisor();
}
#[cfg(not(unix))]
fn main() {
    std::process::exit(78);
}
