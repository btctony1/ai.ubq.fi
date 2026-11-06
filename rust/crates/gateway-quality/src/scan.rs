use crate::targets;
use gateway_quality_syntax::{CATEGORIES, Context, Module, analyze};
use serde::Serialize;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

pub struct Source {
    pub lines: usize,
    pub modules: Vec<Module>,
}

#[derive(Serialize)]
pub struct SourceContext {
    pub source: String,
    pub contexts: Vec<Context>,
}

#[derive(Serialize)]
pub struct TargetInventory {
    pub root: String,
    pub lines: usize,
    pub sources: Vec<String>,
}

#[derive(Default, Serialize)]
pub struct Inventory {
    pub sources: BTreeMap<String, usize>,
    pub targets: BTreeMap<String, TargetInventory>,
}

impl Inventory {
    fn record_target(
        &mut self,
        root: &Path,
        key: String,
        target: &targets::Target,
        closure: targets::Closure,
    ) -> Result<(), String> {
        let mut sources = closure
            .sources
            .iter()
            .map(|file| relative(root, file))
            .collect::<Result<Vec<_>, _>>()?;
        sources.sort();
        self.targets.insert(
            key,
            TargetInventory {
                root: relative(
                    root,
                    &target
                        .path
                        .canonicalize()
                        .map_err(|error| error.to_string())?,
                )?,
                lines: closure.lines,
                sources,
            },
        );
        Ok(())
    }
}

pub struct Scan {
    pub crates: BTreeMap<String, usize>,
    pub targets: BTreeMap<String, usize>,
    pub violations: BTreeMap<String, BTreeMap<String, usize>>,
    pub files: usize,
    pub contexts: BTreeMap<String, SourceContext>,
    pub inventory: Inventory,
}

impl Scan {
    fn record_targets(
        &mut self,
        root: &Path,
        packages: Vec<(String, PathBuf, toml::Value)>,
        sources: &BTreeMap<PathBuf, Source>,
    ) -> Result<(), String> {
        for (name, path, value) in packages {
            for target in targets::discover(&path, &value)? {
                let key = format!("{name}/{}/{}", target.kind, target.name);
                let closure = targets::lines(&target.path, sources)?;
                if self.targets.insert(key.clone(), closure.lines).is_some() {
                    return Err(format!("duplicate Cargo target {key}"));
                }
                self.inventory.record_target(root, key, &target, closure)?;
            }
        }
        Ok(())
    }
}

pub fn relative(root: &Path, path: &Path) -> Result<String, String> {
    path.strip_prefix(root)
        .map(|value| value.to_string_lossy().replace('\\', "/"))
        .map_err(|_| format!("{} escapes first-party source root", path.display()))
}

fn files(directory: &Path, output: &mut Vec<PathBuf>) -> Result<(), String> {
    let entries =
        fs::read_dir(directory).map_err(|error| format!("{}: {error}", directory.display()))?;
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let kind = entry.file_type().map_err(|error| error.to_string())?;
        if kind.is_symlink() {
            return Err(format!(
                "{}: linked first-party paths are unsupported",
                entry.path().display()
            ));
        }
        if kind.is_dir() {
            files(&entry.path(), output)?;
        } else if entry.path().extension().is_some_and(|value| value == "rs") {
            output.push(entry.path());
        }
    }
    Ok(())
}

pub fn manifest(path: &Path) -> Result<toml::Value, String> {
    let text = fs::read_to_string(path).map_err(|error| format!("{}: {error}", path.display()))?;
    toml::from_str::<toml::Value>(&text)
        .map_err(|error| format!("{}: TOML parse error: {error}", path.display()))
}

pub fn scan(root: &Path) -> Result<Scan, String> {
    let root = root.canonicalize().map_err(|error| error.to_string())?;
    let root = root.as_path();
    let directory = root.join("rust/crates");
    let workspace = manifest(&root.join("rust/Cargo.toml"))?;
    let members = workspace
        .get("workspace")
        .and_then(|table| table.get("members"))
        .and_then(toml::Value::as_array)
        .ok_or("Rust workspace requires explicit members")?;
    let mut packages = Vec::new();
    for entry in fs::read_dir(&directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        if !entry
            .file_type()
            .map_err(|error| error.to_string())?
            .is_dir()
        {
            return Err(format!(
                "{}: expected a regular first-party crate directory",
                entry.path().display()
            ));
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if !members
            .iter()
            .any(|member| member.as_str() == Some(&format!("crates/{name}")))
        {
            return Err(format!(
                "{name}: first-party crate is absent from explicit workspace members"
            ));
        }
        let path = entry.path();
        let value = manifest(&path.join("Cargo.toml"))?;
        if value
            .get("lints")
            .and_then(|table| table.get("workspace"))
            .and_then(toml::Value::as_bool)
            != Some(true)
        {
            return Err(format!(
                "{}: missing [lints] workspace = true",
                path.display()
            ));
        }
        if value
            .get("package")
            .and_then(|table| table.get("name"))
            .and_then(toml::Value::as_str)
            != Some(name.as_str())
        {
            return Err(format!(
                "{name}: package name must match its owned crate directory"
            ));
        }
        packages.push((name, path, value));
    }
    packages.sort_by(|left, right| left.0.cmp(&right.0));
    if packages.is_empty() {
        return Err("No first-party crates found".into());
    }
    let mut result = Scan {
        crates: BTreeMap::new(),
        targets: BTreeMap::new(),
        violations: CATEGORIES
            .iter()
            .map(|category| ((*category).into(), BTreeMap::new()))
            .collect(),
        files: 0,
        contexts: BTreeMap::new(),
        inventory: Inventory::default(),
    };
    let mut sources = BTreeMap::new();
    for (name, path, _) in &packages {
        let mut owned = Vec::new();
        files(path, &mut owned)?;
        let mut production = 0;
        for file in owned {
            let text = fs::read_to_string(&file)
                .map_err(|error| format!("{}: {error}", file.display()))?;
            let source = analyze(&text).map_err(|error| format!("{}: {error}", file.display()))?;
            let lines = text.lines().count();
            result
                .inventory
                .sources
                .insert(relative(root, &file)?, lines);
            if file.starts_with(path.join("src")) {
                production += lines;
            }
            for (category, count) in source.counts {
                if count > 0 {
                    result
                        .violations
                        .entry(category)
                        .or_default()
                        .insert(relative(root, &file)?, count);
                }
            }
            result.contexts.insert(
                relative(root, &file)?,
                SourceContext {
                    source: text,
                    contexts: source.contexts,
                },
            );
            sources.insert(
                file,
                Source {
                    lines,
                    modules: source.modules,
                },
            );
            result.files += 1;
        }
        result.crates.insert(name.clone(), production);
    }
    result.record_targets(root, packages, &sources)?;
    Ok(result)
}
