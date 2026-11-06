use gateway_quality_syntax::analyze;

#[test]
fn parses_all_visibility_forms_and_inactive_inline_modules() -> Result<(), String> {
    let source = analyze(
        r#"
        #[cfg(any())] mod inactive {
            pub use crate::A;
            pub(crate) use crate::B;
            pub(super) use crate::C;
            pub(in crate::scope) use crate::D;
            pub extern crate external as forwarded;
            pub(self) use crate::Private;
            pub(in self) use crate::AlsoPrivate;
            use crate::PrivateAgain;
        }
    "#,
    )?;
    assert_eq!(source.counts.get("pubUse"), Some(&5));
    Ok(())
}

#[test]
fn nested_cfg_attr_raw_and_qualified_include_are_not_hidden_by_cfg() -> Result<(), String> {
    let source = analyze(
        r#"
        #![allow(dead_code)]
        #[cfg_attr(any(), cfg_attr(all(), path = "other.rs"), expect(unused))]
        mod conditionally_elsewhere {}
        fn sample() {
            include!("one.rs");
            std::include!("two.rs");
            r#include!("three.rs");
            include_str!("text.txt");
            include_bytes!("data.bin");
        }
    "#,
    )?;
    assert_eq!(source.counts.get("path"), Some(&1));
    assert_eq!(source.counts.get("suppression"), Some(&2));
    assert_eq!(source.counts.get("include"), Some(&3));
    Ok(())
}

#[test]
fn macro_templates_and_visibility_forwarding_are_checked() -> Result<(), String> {
    let source = analyze(
        r#"
        macro_rules! exported {
            ($visibility:vis, $item:path) => {
                $visibility use $item;
                pub(crate) use crate::Another;
                #[cfg_attr(any(), path = "hidden.rs")] mod hidden;
                #[allow(unused)] fn suppressed() { std::include!("nested.rs"); }
            };
        }
    "#,
    )?;
    assert_eq!(source.counts.get("pubUse"), Some(&2));
    assert_eq!(source.counts.get("path"), Some(&1));
    assert_eq!(source.counts.get("suppression"), Some(&1));
    assert_eq!(source.counts.get("include"), Some(&1));
    Ok(())
}

#[test]
fn full_parser_ignores_literals_comments_lifetimes_and_unicode() -> Result<(), String> {
    let source = analyze(
        r##"
        // pub use crate::False; #[allow(unused)]
        /* /* nested */ include!("false.rs"); */
        const TEXT: &str = r#"#[path = "false.rs"] pub use Fake;"#;
        const CHAR: char = 'é';
        fn café<'a>(value: &'a str) -> &'a str { value }
        fn byte() { let _ = b'\''; let _ = "include!(fake)"; }
        macro_rules! text { () => { "pub use Fake; #[allow(unused)]" }; }
    "##,
    )?;
    assert!(source.counts.is_empty());
    Ok(())
}

#[test]
fn malformed_rust_and_builtin_metadata_fail_closed_even_under_cfg() {
    for text in [
        "fn broken( {",
        "#[cfg(any())] fn broken() { let = 3; }",
        "#[cfg_attr(any())] fn item() {}",
        "#[cfg_attr(any(), path = 4)] mod item;",
        "macro_rules! bad { () => { #[cfg_attr(any(), path = 3)] mod bad; }; }",
    ] {
        assert!(analyze(text).is_err(), "{text}");
    }
}

#[test]
fn supported_attribute_forwarding_is_parsed_without_ignoring_actual_forbidden_attributes()
-> Result<(), String> {
    let source = analyze(
        r#"
        macro_rules! fields { ($(#[$attr:meta])* $field:ident) => { $(#[$attr])* struct Field; }; }
        fields! { #[allow(unused)] field }
    "#,
    )?;
    assert_eq!(source.counts.get("suppression"), Some(&1));
    assert_eq!(
        analyze("#[r#allow(unused)] fn raw() {}")?
            .counts
            .get("suppression"),
        Some(&1)
    );
    Ok(())
}

#[test]
fn explicit_include_aliases_and_ident_operands_cannot_bypass_inactive_source_checks()
-> Result<(), String> {
    let source = analyze(
        r#"
        use std::include as hidden;
        use hidden as forwarded;
        macro_rules! wrapper { ($name:ident) => { $name!("source.rs"); }; }
        #[cfg(any())] mod inactive {
            fn aliases() { hidden!("one.rs"); forwarded!("two.rs"); }
            wrapper!(include);
            wrapper!(hidden);
        }
        const TEXT: &str = include_str!("text.txt");
        const BYTES: &[u8] = include_bytes!("bytes.bin");
        macro_rules! strings { () => { "include hidden forwarded" }; }
    "#,
    )?;
    assert_eq!(source.counts.get("include"), Some(&4));
    Ok(())
}
