use crate::scan::Scan;
use gateway_quality_syntax::CATEGORIES;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

pub const CAP: usize = 1000;
pub const LOCATION: &str = "rust/quality-baseline.json";

#[derive(Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Baseline {
    pub crates: BTreeMap<String, usize>,
    #[serde(default)]
    pub targets: BTreeMap<String, usize>,
    pub violations: BTreeMap<String, BTreeMap<String, usize>>,
    #[serde(default)]
    pub clippy: BTreeMap<String, BTreeMap<String, usize>>,
    #[serde(default)]
    pub adoption: BTreeMap<String, String>,
}

pub fn read(root: &Path) -> Result<Baseline, String> {
    let baseline: Baseline = serde_json::from_str(
        &fs::read_to_string(root.join(LOCATION)).map_err(|error| format!("{LOCATION}: {error}"))?,
    )
    .map_err(|error| format!("{LOCATION}: {error}"))?;
    if baseline.violations.len() != CATEGORIES.len()
        || CATEGORIES
            .iter()
            .any(|category| !baseline.violations.contains_key(*category))
    {
        return Err("baseline has unknown/missing violation categories".into());
    }
    for (kind, map, minimum) in [
        ("crates", &baseline.crates, CAP + 1),
        ("targets", &baseline.targets, CAP + 1),
    ] {
        validate(kind, map, minimum)?;
    }
    for (kind, map) in baseline.violations.iter().chain(baseline.clippy.iter()) {
        validate(kind, map, 1)?;
    }
    Ok(baseline)
}

fn validate(kind: &str, map: &BTreeMap<String, usize>, minimum: usize) -> Result<(), String> {
    if map
        .iter()
        .any(|(key, count)| key.is_empty() || *count < minimum)
    {
        return Err(format!(
            "invalid {kind} baseline key/count; minimum {minimum}"
        ));
    }
    Ok(())
}

pub fn current(scan: &Scan) -> Baseline {
    Baseline {
        crates: scan
            .crates
            .iter()
            .filter(|(_, count)| **count > CAP)
            .map(|(key, count)| (key.clone(), *count))
            .collect(),
        targets: scan
            .targets
            .iter()
            .filter(|(_, count)| **count > CAP)
            .map(|(key, count)| (key.clone(), *count))
            .collect(),
        violations: scan.violations.clone(),
        ..Baseline::default()
    }
}

fn compare(
    kind: &str,
    actual: &BTreeMap<String, usize>,
    recorded: &BTreeMap<String, usize>,
    update: bool,
    errors: &mut Vec<String>,
) {
    for (key, count) in actual {
        let previous = recorded.get(key).copied().unwrap_or(0);
        if *count > previous {
            errors.push(format!(
                "{key} [{kind}]: grew to {count} from {previous}; update never adds debt"
            ));
        }
    }
    if !update {
        for (key, count) in recorded {
            let next = actual.get(key).copied().unwrap_or(0);
            if next < *count {
                errors.push(format!("{key} [{kind}]: shrank to {next} from {count}; run `bun run rust:quality:update` to tighten it"));
            }
        }
    }
}

pub fn reconcile(root: &Path, scan: &Scan, mode: &str) -> Result<(), String> {
    let path = root.join(LOCATION);
    if mode == "--init" && path.exists() {
        return Err(format!(
            "{LOCATION} already exists; --init refuses to replace debt"
        ));
    }
    let mut next = current(scan);
    if mode != "--init" && mode != "--report" {
        let previous = read(root)?;
        let mut errors = Vec::new();
        compare(
            "production lines, cap 1000",
            &next.crates,
            &previous.crates,
            mode == "--update",
            &mut errors,
        );
        compare(
            "target lines, cap 1000",
            &next.targets,
            &previous.targets,
            mode == "--update",
            &mut errors,
        );
        for category in CATEGORIES {
            compare(
                category,
                &next.violations[category],
                &previous.violations[category],
                mode == "--update",
                &mut errors,
            );
        }
        if !errors.is_empty() {
            return Err(errors.join("\n"));
        }
        next.clippy = previous.clippy;
        next.adoption = previous.adoption;
    }
    if mode == "--report" {
        println!(
            "{}",
            serde_json::to_string_pretty(&next).map_err(|error| error.to_string())?
        );
    } else {
        if mode == "--update" || mode == "--init" {
            fs::write(
                path,
                format!(
                    "{}\n",
                    serde_json::to_string_pretty(&next).map_err(|error| error.to_string())?
                ),
            )
            .map_err(|error| error.to_string())?;
        }
        println!(
            "rust:quality: {}: {} crates, {} Rust files, {} separate Cargo targets; {} oversized production crates, {} oversized targets; cap {CAP}",
            mode,
            scan.crates.len(),
            scan.files,
            scan.targets.len(),
            next.crates.len(),
            next.targets.len()
        );
    }
    Ok(())
}
