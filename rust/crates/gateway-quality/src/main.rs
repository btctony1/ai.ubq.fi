use gateway_quality::{baseline, scan};
use std::path::Path;

fn run() -> Result<(), String> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let [mode, root] = args.as_slice() else {
        return Err(
            "usage: gateway-quality --check|--update|--init|--report|--inventory REPOSITORY_ROOT"
                .into(),
        );
    };
    if !["--check", "--update", "--init", "--report", "--inventory"].contains(&mode.as_str()) {
        return Err("unknown quality mode".into());
    }
    let root = Path::new(root)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let scanned = scan::scan(&root)?;
    if mode == "--inventory" {
        println!(
            "{}",
            serde_json::to_string_pretty(&scanned.inventory).map_err(|error| error.to_string())?
        );
        return Ok(());
    }
    baseline::reconcile(&root, &scanned, mode)?;
    if let Some(target) = std::env::var_os("CARGO_TARGET_DIR") {
        let destination = Path::new(&target).join("quality-contexts.json");
        std::fs::create_dir_all(Path::new(&target)).map_err(|error| error.to_string())?;
        let document = serde_json::json!({ "root": root, "files": scanned.contexts });
        std::fs::write(
            destination,
            serde_json::to_vec(&document).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("rust:quality: FAILED: {error}");
        std::process::exit(1);
    }
}
