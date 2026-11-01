use proc_macro2::{Delimiter, TokenStream, TokenTree};
use quote::ToTokens;
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use syn::parse::Parser;
use syn::punctuated::Punctuated;
use syn::spanned::Spanned;
use syn::visit::{self, Visit};
use syn::{Attribute, Expr, ItemExternCrate, ItemMod, ItemUse, Lit, Meta, Token, Visibility};

pub const CATEGORIES: [&str; 4] = ["pubUse", "path", "include", "suppression"];

#[derive(Default)]
pub struct Analysis {
    pub counts: BTreeMap<String, usize>,
    pub modules: Vec<Module>,
    pub errors: Vec<String>,
    pub contexts: Vec<Context>,
    conditions: Vec<String>,
    prefix: Vec<String>,
    include_names: BTreeSet<String>,
}

#[derive(Serialize)]
pub struct Context {
    pub start_line: usize,
    pub start_column: usize,
    pub end_line: usize,
    pub end_column: usize,
    pub tokens: String,
}

pub struct Module {
    pub prefix: Vec<String>,
    pub name: String,
    pub paths: Vec<String>,
    pub direct_path: bool,
}

fn name(identifier: &syn::Ident) -> String {
    let text = identifier.to_string();
    text.strip_prefix("r#").unwrap_or(&text).to_owned()
}

fn visible(visibility: &Visibility) -> bool {
    match visibility {
        Visibility::Inherited => false,
        Visibility::Restricted(restricted) => !restricted.path.is_ident("self"),
        Visibility::Public(_) => true,
    }
}

fn named(path: &syn::Path, expected: &str) -> bool {
    path.segments.len() == 1
        && path
            .segments
            .first()
            .is_some_and(|segment| name(&segment.ident) == expected)
}

fn metadata(
    meta: &Meta,
    counts: &mut BTreeMap<String, usize>,
    paths: &mut Vec<String>,
) -> syn::Result<()> {
    if named(meta.path(), "path") {
        *counts.entry("path".into()).or_default() += 1;
        match meta {
            Meta::NameValue(value) => match &value.value {
                Expr::Lit(literal) => match &literal.lit {
                    Lit::Str(path) => paths.push(path.value()),
                    _ => {
                        return Err(syn::Error::new_spanned(
                            meta,
                            "path must be a string literal",
                        ));
                    }
                },
                _ => {
                    return Err(syn::Error::new_spanned(
                        meta,
                        "path must be a string literal",
                    ));
                }
            },
            _ => {
                return Err(syn::Error::new_spanned(
                    meta,
                    "path must be a string literal",
                ));
            }
        }
    } else if named(meta.path(), "allow") || named(meta.path(), "expect") {
        *counts.entry("suppression".into()).or_default() += 1;
    } else if named(meta.path(), "cfg_attr") {
        let Meta::List(list) = meta else {
            return Err(syn::Error::new_spanned(
                meta,
                "cfg_attr must contain a predicate and attributes",
            ));
        };
        let nested = Punctuated::<Meta, Token![,]>::parse_terminated.parse2(list.tokens.clone())?;
        if nested.len() < 2 {
            return Err(syn::Error::new_spanned(
                meta,
                "cfg_attr must contain a predicate and attributes",
            ));
        }
        for attribute in nested.iter().skip(1) {
            metadata(attribute, counts, paths)?;
        }
    }
    Ok(())
}

impl Analysis {
    fn context(&mut self, item: &impl ToTokens, span: proc_macro2::Span) {
        self.contexts.push(Context {
            start_line: span.start().line,
            start_column: span.start().column + 1,
            end_line: span.end().line,
            end_column: span.end().column + 1,
            tokens: format!(
                "{} {}",
                self.conditions
                    .iter()
                    .filter(|value| !value.is_empty())
                    .cloned()
                    .collect::<Vec<_>>()
                    .join(" "),
                item.to_token_stream()
            ),
        });
    }

    fn attribute(&mut self, attribute: &Attribute) {
        if let Err(error) = metadata(&attribute.meta, &mut self.counts, &mut Vec::new()) {
            self.errors.push(error.to_string());
        }
    }
}

impl<'ast> Visit<'ast> for Analysis {
    fn visit_item(&mut self, item: &'ast syn::Item) {
        self.context(item, item.span());
        visit::visit_item(self, item);
    }

    fn visit_impl_item(&mut self, item: &'ast syn::ImplItem) {
        self.context(item, item.span());
        visit::visit_impl_item(self, item);
    }

    fn visit_trait_item(&mut self, item: &'ast syn::TraitItem) {
        self.context(item, item.span());
        visit::visit_trait_item(self, item);
    }

    fn visit_item_impl(&mut self, item: &'ast syn::ItemImpl) {
        let mut header = item.clone();
        header.items.clear();
        self.conditions.push(header.to_token_stream().to_string());
        visit::visit_item_impl(self, item);
        self.conditions.pop();
    }

    fn visit_item_use(&mut self, item: &'ast ItemUse) {
        if visible(&item.vis) {
            *self.counts.entry("pubUse".into()).or_default() += 1;
        }
        visit::visit_item_use(self, item);
    }

    fn visit_item_extern_crate(&mut self, item: &'ast ItemExternCrate) {
        if visible(&item.vis) {
            *self.counts.entry("pubUse".into()).or_default() += 1;
        }
        visit::visit_item_extern_crate(self, item);
    }

    fn visit_attribute(&mut self, attribute: &'ast Attribute) {
        self.attribute(attribute);
    }

    fn visit_macro(&mut self, mac: &'ast syn::Macro) {
        if mac
            .path
            .segments
            .last()
            .is_some_and(|segment| self.include_names.contains(&name(&segment.ident)))
        {
            *self.counts.entry("include".into()).or_default() += 1;
        }
        // syn deliberately leaves macro bodies opaque. Inspect authored token
        // trees (never strings/comments), including macro_rules templates.
        macro_tokens(
            mac.tokens.clone(),
            &mut self.counts,
            &mut self.errors,
            &BTreeSet::new(),
            &self.include_names,
        );
    }

    fn visit_item_mod(&mut self, item: &'ast ItemMod) {
        if item.content.is_none() {
            let mut paths = Vec::new();
            for attribute in &item.attrs {
                if let Err(error) = metadata(&attribute.meta, &mut BTreeMap::new(), &mut paths) {
                    self.errors.push(error.to_string());
                }
            }
            self.modules.push(Module {
                prefix: self.prefix.clone(),
                name: name(&item.ident),
                paths,
                direct_path: item
                    .attrs
                    .iter()
                    .any(|attribute| attribute.path().is_ident("path")),
            });
        }
        for attribute in &item.attrs {
            self.attribute(attribute);
        }
        if let Some((_, items)) = &item.content {
            self.conditions.push(
                item.attrs
                    .iter()
                    .filter(|attribute| {
                        attribute.path().is_ident("cfg") || attribute.path().is_ident("cfg_attr")
                    })
                    .map(ToTokens::to_token_stream)
                    .map(|tokens| tokens.to_string())
                    .collect::<Vec<_>>()
                    .join(" "),
            );
            self.prefix.push(name(&item.ident));
            for child in items {
                self.visit_item(child);
            }
            self.prefix.pop();
            self.conditions.pop();
        }
    }
}

fn ident(token: Option<&TokenTree>, expected: &str) -> bool {
    matches!(token, Some(TokenTree::Ident(value)) if name(value) == expected)
}

fn punct(token: Option<&TokenTree>, expected: char) -> bool {
    matches!(token, Some(TokenTree::Punct(value)) if value.as_char() == expected)
}

fn forwarded_visibilities(tokens: &[TokenTree], inherited: &BTreeSet<String>) -> BTreeSet<String> {
    let mut names = inherited.clone();
    for window in tokens.windows(4) {
        if punct(window.first(), '$')
            && punct(window.get(2), ':')
            && ident(window.get(3), "vis")
            && let TokenTree::Ident(value) = &window[1]
        {
            names.insert(name(value));
        }
    }
    for token in tokens {
        if let TokenTree::Group(group) = token {
            names.extend(forwarded_visibilities(
                &group.stream().into_iter().collect::<Vec<_>>(),
                inherited,
            ));
        }
    }
    names
}

fn macro_attribute(
    tokens: TokenStream,
    counts: &mut BTreeMap<String, usize>,
    errors: &mut Vec<String>,
) {
    let forwarded: Vec<_> = tokens.clone().into_iter().collect();
    let placeholder = punct(forwarded.first(), '$')
        && matches!(forwarded.get(1), Some(TokenTree::Ident(_)))
        && (forwarded.len() == 2
            || (forwarded.len() == 4
                && punct(forwarded.get(2), ':')
                && ident(forwarded.get(3), "meta")));
    if placeholder {
        return;
    }
    let result =
        syn::parse2::<Meta>(tokens).and_then(|meta| metadata(&meta, counts, &mut Vec::new()));
    if let Err(error) = result {
        errors.push(format!("unsupported macro-authored attribute: {error}"));
    }
}

fn macro_tokens(
    stream: TokenStream,
    counts: &mut BTreeMap<String, usize>,
    errors: &mut Vec<String>,
    inherited: &BTreeSet<String>,
    include_names: &BTreeSet<String>,
) {
    let tokens: Vec<_> = stream.into_iter().collect();
    let forwarded = forwarded_visibilities(&tokens, inherited);
    for (index, token) in tokens.iter().enumerate() {
        if let TokenTree::Ident(value) = token
            && include_names.contains(&name(value))
        {
            // An include operand may be forwarded through an ident metavariable.
            // Conservative authored-token coverage also inspects inactive templates.
            *counts.entry("include".into()).or_default() += 1;
        }
        if ident(Some(token), "pub") {
            let suffix: TokenStream = tokens[index..].iter().cloned().collect();
            let parser = |input: syn::parse::ParseStream<'_>| {
                let visibility: Visibility = input.parse()?;
                let declaration = input.peek(Token![use])
                    || (input.peek(Token![extern]) && input.peek2(Token![crate]));
                let _: TokenStream = input.parse()?;
                Ok(visible(&visibility) && declaration)
            };
            if parser.parse2(suffix).unwrap_or(false) {
                *counts.entry("pubUse".into()).or_default() += 1;
            }
        }
        if punct(Some(token), '$')
            && let Some(TokenTree::Ident(value)) = tokens.get(index + 1)
            && forwarded.contains(&name(value))
            && ident(tokens.get(index + 2), "use")
        {
            *counts.entry("pubUse".into()).or_default() += 1;
        }
        if punct(Some(token), '#') {
            let offset = usize::from(punct(tokens.get(index + 1), '!'));
            if let Some(TokenTree::Group(group)) = tokens.get(index + 1 + offset)
                && group.delimiter() == Delimiter::Bracket
            {
                macro_attribute(group.stream(), counts, errors);
            }
        }
        if let TokenTree::Group(group) = token {
            macro_tokens(group.stream(), counts, errors, &forwarded, include_names);
        }
    }
}

#[derive(Default)]
struct IncludeAliases(Vec<(String, String)>);
impl<'ast> Visit<'ast> for IncludeAliases {
    fn visit_use_rename(&mut self, rename: &'ast syn::UseRename) {
        self.0.push((name(&rename.ident), name(&rename.rename)));
    }
}

fn inclusion_names(file: &syn::File) -> BTreeSet<String> {
    let mut aliases = IncludeAliases::default();
    aliases.visit_file(file);
    let mut names = BTreeSet::from(["include".into()]);
    loop {
        let before = names.len();
        for (source, destination) in &aliases.0 {
            if names.contains(source) {
                names.insert(destination.clone());
            }
        }
        if before == names.len() {
            return names;
        }
    }
}

pub fn analyze(text: &str) -> Result<Analysis, String> {
    let file = syn::parse_file(text).map_err(|error| {
        format!(
            "Rust parse error at {}:{}: {error}",
            error.span().start().line,
            error.span().start().column + 1
        )
    })?;
    let mut analysis = Analysis {
        include_names: inclusion_names(&file),
        ..Analysis::default()
    };
    analysis.visit_file(&file);
    if analysis.errors.is_empty() {
        Ok(analysis)
    } else {
        Err(analysis.errors.join("; "))
    }
}
