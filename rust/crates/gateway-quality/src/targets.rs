use crate::scan::Source;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

pub struct Target {
    pub kind: String,
    pub name: String,
    pub path: PathBuf,
}

pub struct Closure {
    pub lines: usize,
    pub sources: BTreeSet<PathBuf>,
}

fn explicit(directory: &Path, value: &toml::Value, kind: &str) -> Result<Vec<Target>, String> {
    let mut targets = Vec::new();
    if let Some(entries) = value.get(kind).and_then(toml::Value::as_array) {
        for entry in entries {
            let name = entry
                .get("name")
                .and_then(toml::Value::as_str)
                .ok_or("explicit Cargo target needs a name")?;
            let conventional = if kind == "bin" {
                format!("src/bin/{name}.rs")
            } else {
                format!(
                    "{}/{name}.rs",
                    if kind == "bench" {
                        "benches"
                    } else if kind == "test" {
                        "tests"
                    } else {
                        "examples"
                    }
                )
            };
            let path = entry
                .get("path")
                .and_then(toml::Value::as_str)
                .unwrap_or(&conventional);
            targets.push(Target {
                kind: kind.into(),
                name: name.into(),
                path: directory.join(path),
            });
        }
    }
    Ok(targets)
}

pub fn discover(directory: &Path, value: &toml::Value) -> Result<Vec<Target>, String> {
    let mut targets = Vec::new();
    for (kind, folder, automatic) in [
        ("test", "tests", "autotests"),
        ("example", "examples", "autoexamples"),
        ("bench", "benches", "autobenches"),
        ("bin", "src/bin", "autobins"),
    ] {
        let mut found = explicit(directory, value, kind)?;
        let enabled = value
            .get("package")
            .and_then(|package| package.get(automatic))
            .and_then(toml::Value::as_bool)
            != Some(false);
        if enabled && directory.join(folder).is_dir() {
            for entry in fs::read_dir(directory.join(folder)).map_err(|error| error.to_string())? {
                let entry = entry.map_err(|error| error.to_string())?;
                let path = entry.path();
                let source = if path.is_dir() {
                    path.join("main.rs")
                } else {
                    path.clone()
                };
                if !source.is_file() || source.extension().is_none_or(|extension| extension != "rs")
                {
                    continue;
                }
                let name = if path.is_dir() {
                    path.file_name()
                } else {
                    path.file_stem()
                }
                .ok_or("Cargo target has no name")?
                .to_string_lossy()
                .into_owned();
                if !found.iter().any(|target| target.name == name) {
                    found.push(Target {
                        kind: kind.into(),
                        name,
                        path: source,
                    });
                }
            }
        }
        targets.extend(found);
    }
    let build = value
        .get("package")
        .and_then(|package| package.get("build"));
    if build.and_then(toml::Value::as_bool) != Some(false) {
        let path = directory.join(build.and_then(toml::Value::as_str).unwrap_or("build.rs"));
        if build.and_then(toml::Value::as_str).is_some() || path.exists() {
            targets.push(Target {
                kind: "build".into(),
                name: "build-script".into(),
                path,
            });
        }
    }
    if directory.join("src/main.rs").is_file()
        && value
            .get("package")
            .and_then(|package| package.get("autobins"))
            .and_then(toml::Value::as_bool)
            != Some(false)
    {
        targets.push(Target {
            kind: "bin".into(),
            name: directory
                .file_name()
                .ok_or("crate has no name")?
                .to_string_lossy()
                .into_owned(),
            path: directory.join("src/main.rs"),
        });
    }
    targets.sort_by(|left, right| (&left.kind, &left.name).cmp(&(&right.kind, &right.name)));
    Ok(targets)
}

fn normalized(path: &Path) -> Result<PathBuf, String> {
    fs::canonicalize(path).map_err(|error| {
        format!(
            "{}: target/module source is missing: {error}",
            path.display()
        )
    })
}

fn closure(
    file: &Path,
    directory: &Path,
    sources: &BTreeMap<PathBuf, Source>,
    visited: &mut BTreeSet<PathBuf>,
    active: &mut BTreeSet<PathBuf>,
) -> Result<usize, String> {
    let file = normalized(file)?;
    if active.contains(&file) {
        return Err(format!("{}: cyclic source module graph", file.display()));
    }
    if !visited.insert(file.clone()) {
        return Ok(0);
    }
    active.insert(file.clone());
    let source = sources.get(&file).ok_or_else(|| {
        format!(
            "{}: target escapes authored first-party Rust source",
            file.display()
        )
    })?;
    let mut count = source.lines;
    for module in &source.modules {
        let base = module
            .prefix
            .iter()
            .fold(directory.to_path_buf(), |path, part| path.join(part));
        let mut paths = module
            .paths
            .iter()
            .map(|path| base.join(path))
            .collect::<Vec<_>>();
        if !module.direct_path {
            let plain = base.join(format!("{}.rs", module.name));
            let nested = base.join(&module.name).join("mod.rs");
            if plain.exists() && nested.exists() {
                return Err(format!(
                    "{}: ambiguous conventional module {}",
                    base.display(),
                    module.name
                ));
            }
            if plain.exists() {
                paths.push(plain);
            } else if nested.exists() {
                paths.push(nested);
            } else if paths.is_empty() {
                return Err(format!(
                    "{}: missing conventional module {}",
                    base.display(),
                    module.name
                ));
            }
        }
        for path in paths {
            let path = normalized(&path)?;
            let parent = path.parent().ok_or("module source has no parent")?;
            let child_directory = if path.file_name().is_some_and(|name| name == "mod.rs") {
                parent.to_path_buf()
            } else {
                parent.join(path.file_stem().ok_or("module source has no stem")?)
            };
            count += closure(&path, &child_directory, sources, visited, active)?;
        }
    }
    active.remove(&file);
    Ok(count)
}

pub fn lines(root: &Path, sources: &BTreeMap<PathBuf, Source>) -> Result<Closure, String> {
    let root = normalized(root)?;
    let mut visited = BTreeSet::new();
    let lines = closure(
        &root,
        root.parent().ok_or("target source has no parent")?,
        sources,
        &mut visited,
        &mut BTreeSet::new(),
    )?;
    Ok(Closure {
        lines,
        sources: visited,
    })
}
