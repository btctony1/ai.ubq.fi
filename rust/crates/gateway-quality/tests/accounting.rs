use gateway_quality::{baseline, scan};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT: AtomicU64 = AtomicU64::new(0);

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Result<Self, String> {
        let root = std::env::temp_dir().join(format!(
            "uos-quality-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let fixture = Self(root);
        fixture.write(
            "rust/Cargo.toml",
            "[workspace]\nmembers=['crates/fixture']\n",
        )?;
        fixture.write(
            "rust/crates/fixture/Cargo.toml",
            "[package]\nname='fixture'\n[lints]\nworkspace=true\n",
        )?;
        fixture.write("rust/crates/fixture/src/lib.rs", "pub fn source() {}\n")?;
        Ok(fixture)
    }
    fn write(&self, path: &str, text: &str) -> Result<(), String> {
        let path = self.0.join(path);
        fs::create_dir_all(path.parent().ok_or("fixture path has no parent")?)
            .map_err(|error| error.to_string())?;
        fs::write(path, text).map_err(|error| error.to_string())
    }
    fn scan(&self) -> Result<scan::Scan, String> {
        scan::scan(&self.0)
    }
    fn reconcile(&self, mode: &str) -> Result<(), String> {
        baseline::reconcile(&self.0, &self.scan()?, mode)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _removed = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn production_and_each_test_target_have_separate_physical_closures() -> Result<(), String> {
    let fixture = Fixture::new()?;
    fixture.write(
        "rust/crates/fixture/src/lib.rs",
        &"// source\n".repeat(1001),
    )?;
    fixture.write(
        "rust/crates/fixture/tests/first.rs",
        "mod support;\n// root\n",
    )?;
    fixture.write("rust/crates/fixture/tests/second.rs", "mod support;\n")?;
    fixture.write(
        "rust/crates/fixture/tests/support/mod.rs",
        &"// helper\n".repeat(1000),
    )?;
    let result = fixture.scan()?;
    assert_eq!(result.crates["fixture"], 1001);
    assert_eq!(result.targets["fixture/test/first"], 1002);
    assert_eq!(result.targets["fixture/test/second"], 1001);
    assert_eq!(
        result.inventory.targets["fixture/test/first"].sources,
        [
            "rust/crates/fixture/tests/first.rs",
            "rust/crates/fixture/tests/support/mod.rs"
        ]
    );
    assert_eq!(
        result.inventory.sources["rust/crates/fixture/src/lib.rs"],
        1001
    );
    assert_eq!(result.inventory.targets["fixture/test/second"].lines, 1001);
    fixture.reconcile("--init")?;
    assert_eq!(baseline::read(&fixture.0)?.targets.len(), 2);
    fixture.reconcile("--check")?;
    Ok(())
}

#[test]
fn conditional_paths_and_inline_modules_charge_every_reachable_file_once() -> Result<(), String> {
    let fixture = Fixture::new()?;
    fixture.write(
        "rust/crates/fixture/tests/fixture.rs",
        "mod inline { #[cfg_attr(any(), path=\"alternate.rs\")] mod child; }\n",
    )?;
    fixture.write(
        "rust/crates/fixture/tests/inline/alternate.rs",
        "// alternate\n// second\n",
    )?;
    fixture.write("rust/crates/fixture/tests/inline/child.rs", "// default\n")?;
    let result = fixture.scan()?;
    assert_eq!(result.targets["fixture/test/fixture"], 4);
    assert_eq!(
        result.inventory.targets["fixture/test/fixture"].sources,
        [
            "rust/crates/fixture/tests/fixture.rs",
            "rust/crates/fixture/tests/inline/alternate.rs",
            "rust/crates/fixture/tests/inline/child.rs"
        ]
    );
    Ok(())
}

#[test]
fn explicit_targets_build_scripts_and_disabled_autodiscovery_are_accounted() -> Result<(), String> {
    let fixture = Fixture::new()?;
    fixture.write("rust/crates/fixture/Cargo.toml", "[package]\nname='fixture'\nautotests=false\nbuild='support/build.rs'\n[[test]]\nname='explicit'\npath='support/test.rs'\n[[bench]]\nname='speed'\n[lints]\nworkspace=true\n")?;
    for path in [
        "support/build.rs",
        "support/test.rs",
        "benches/speed.rs",
        "tests/disabled.rs",
    ] {
        fixture.write(&format!("rust/crates/fixture/{path}"), "// authored\n")?;
    }
    let result = fixture.scan()?;
    assert_eq!(result.targets.len(), 3);
    assert_eq!(result.targets["fixture/test/explicit"], 1);
    assert_eq!(result.targets["fixture/bench/speed"], 1);
    assert_eq!(result.targets["fixture/build/build-script"], 1);
    Ok(())
}

#[test]
fn updates_only_shrink_and_never_record_new_or_growing_target_debt() -> Result<(), String> {
    let fixture = Fixture::new()?;
    fixture.write(
        "rust/crates/fixture/tests/big.rs",
        &"// test\n".repeat(1002),
    )?;
    fixture.reconcile("--init")?;
    let original =
        fs::read(fixture.0.join(baseline::LOCATION)).map_err(|error| error.to_string())?;
    fixture.write(
        "rust/crates/fixture/tests/big.rs",
        &"// test\n".repeat(1003),
    )?;
    assert!(fixture.reconcile("--update").is_err());
    assert_eq!(
        fs::read(fixture.0.join(baseline::LOCATION)).map_err(|error| error.to_string())?,
        original
    );
    fixture.write(
        "rust/crates/fixture/tests/big.rs",
        &"// test\n".repeat(1001),
    )?;
    assert!(fixture.reconcile("--check").is_err());
    fixture.reconcile("--update")?;
    assert_eq!(
        baseline::read(&fixture.0)?.targets["fixture/test/big"],
        1001
    );
    fixture.write(
        "rust/crates/fixture/tests/new.rs",
        &"// test\n".repeat(1001),
    )?;
    assert!(fixture.reconcile("--update").is_err());
    fs::remove_file(fixture.0.join("rust/crates/fixture/tests/new.rs"))
        .map_err(|error| error.to_string())?;
    fixture.write("rust/crates/fixture/tests/big.rs", "// bounded\n")?;
    fixture.reconcile("--update")?;
    assert!(baseline::read(&fixture.0)?.targets.is_empty());
    assert!(fixture.reconcile("--init").is_err());
    Ok(())
}

#[test]
fn parser_and_manifest_failures_never_write_a_baseline() -> Result<(), String> {
    let fixture = Fixture::new()?;
    for text in ["[lints]\nworkspace=false\n", "[lints]\nworkspace = tru\n"] {
        fixture.write("rust/crates/fixture/Cargo.toml", text)?;
        assert!(fixture.reconcile("--init").is_err());
        assert!(!fixture.0.join(baseline::LOCATION).exists());
    }
    fixture.write(
        "rust/crates/fixture/Cargo.toml",
        "[package]\nname='fixture'\n[lints.workspace]\n",
    )?;
    assert!(fixture.scan().is_err());
    Ok(())
}

#[test]
fn target_sources_cannot_escape_the_first_party_tree() -> Result<(), String> {
    let fixture = Fixture::new()?;
    fixture.write("external.rs", "// unowned\n")?;
    fixture.write(
        "rust/crates/fixture/tests/escape.rs",
        "#[path=\"../../../../external.rs\"] mod escape;\n",
    )?;
    assert!(fixture.scan().is_err());
    Ok(())
}

#[test]
fn missing_ambiguous_and_cyclic_module_graphs_fail_closed() -> Result<(), String> {
    let fixture = Fixture::new()?;
    fixture.write("rust/crates/fixture/tests/entry.rs", "mod absent;\n")?;
    assert!(fixture.scan().is_err());
    fixture.write("rust/crates/fixture/tests/absent.rs", "// one\n")?;
    fixture.write("rust/crates/fixture/tests/absent/mod.rs", "// two\n")?;
    assert!(fixture.scan().is_err());
    fs::remove_file(fixture.0.join("rust/crates/fixture/tests/absent/mod.rs"))
        .map_err(|error| error.to_string())?;
    fixture.write(
        "rust/crates/fixture/tests/absent.rs",
        "#[path=\"../entry.rs\"] mod cycle;\n",
    )?;
    assert!(fixture.scan().is_err());
    Ok(())
}

#[test]
fn binary_scans_real_fixture_files_and_returns_failure_for_invalid_inactive_code()
-> Result<(), String> {
    let fixture = Fixture::new()?;
    let run = |mode| {
        std::process::Command::new(env!("CARGO_BIN_EXE_gateway-quality"))
            .args([mode, fixture.0.to_str().unwrap_or("")])
            .output()
            .map_err(|error| error.to_string())
    };
    assert!(run("--init")?.status.success());
    fixture.write(
        "rust/crates/fixture/src/lib.rs",
        "#[cfg(any())] fn invalid() { let = 4; }\n",
    )?;
    assert!(!run("--check")?.status.success());
    assert!(Path::new(env!("CARGO_BIN_EXE_gateway-quality")).is_file());
    Ok(())
}

#[test]
fn inventory_is_sorted_read_only_and_keeps_report_and_context_contracts() -> Result<(), String> {
    let fixture = Fixture::new()?;
    fixture.write("rust/crates/fixture/tests/z.rs", "// last\n")?;
    fixture.write("rust/crates/fixture/tests/a.rs", "// first\n")?;
    let context_directory = fixture.0.join("contexts");
    let run = |mode| {
        std::process::Command::new(env!("CARGO_BIN_EXE_gateway-quality"))
            .args([mode, fixture.0.to_str().unwrap_or("")])
            .env("CARGO_TARGET_DIR", &context_directory)
            .output()
            .map_err(|error| error.to_string())
    };
    let output = run("--inventory")?;
    assert!(output.status.success());
    assert!(!fixture.0.join(baseline::LOCATION).exists());
    assert!(!context_directory.exists());
    let expected = format!(
        "{}\n",
        serde_json::to_string_pretty(&fixture.scan()?.inventory)
            .map_err(|error| error.to_string())?
    );
    assert_eq!(String::from_utf8_lossy(&output.stdout), expected);
    let paths: Vec<_> = fixture.scan()?.inventory.sources.into_keys().collect();
    assert_eq!(
        paths,
        [
            "rust/crates/fixture/src/lib.rs",
            "rust/crates/fixture/tests/a.rs",
            "rust/crates/fixture/tests/z.rs"
        ]
    );
    let report = run("--report")?;
    assert!(report.status.success());
    let report: serde_json::Value =
        serde_json::from_slice(&report.stdout).map_err(|error| error.to_string())?;
    assert!(report.get("inventory").is_none());
    assert_eq!(report["crates"], serde_json::json!({}));
    assert!(context_directory.join("quality-contexts.json").is_file());
    assert!(!fixture.0.join(baseline::LOCATION).exists());
    Ok(())
}

#[test]
fn target_inventory_sorts_normalized_paths_with_same_stem_files_and_directories()
-> Result<(), String> {
    let fixture = Fixture::new()?;
    fixture.write(
        "rust/crates/fixture/tests/entry.rs",
        "mod entry { mod child; }\n",
    )?;
    fixture.write("rust/crates/fixture/tests/entry/child.rs", "// child\n")?;
    let result = fixture.scan()?;
    assert_eq!(result.inventory.targets["fixture/test/entry"].lines, 2);
    assert_eq!(
        result.inventory.targets["fixture/test/entry"].sources,
        [
            "rust/crates/fixture/tests/entry.rs",
            "rust/crates/fixture/tests/entry/child.rs"
        ]
    );
    Ok(())
}
