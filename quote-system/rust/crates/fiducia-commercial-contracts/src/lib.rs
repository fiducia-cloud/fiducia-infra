#![forbid(unsafe_code)]

//! Canonical commercial-intake contract sources.
//!
//! TypeSpec owns HTTP operations and cross-language transport models. JSON
//! Schema Draft 2020-12 owns portable payload validation. PostgreSQL owns the
//! encrypted persistence shape. The ORM crates are generated projections and
//! never become public wire contracts.

/// Canonical TypeSpec source for public and administrative HTTP operations.
pub const TYPESPEC_SOURCE: &str = include_str!("../../../../contracts/main.tsp");

/// Canonical JSON Schema Draft 2020-12 payload contract.
pub const JSON_SCHEMA_SOURCE: &str =
    include_str!("../../../../contracts/commercial-intake.schema.json");

/// Canonical PostgreSQL migration for the commercial persistence boundary.
pub const POSTGRES_MIGRATION_SOURCE: &str =
    include_str!("../../../../db/0001_commercial_intake.sql");

#[cfg(test)]
mod tests {
    use super::{
        JSON_SCHEMA_SOURCE, POSTGRES_MIGRATION_SOURCE, TYPESPEC_SOURCE,
    };

    #[test]
    fn contract_sources_are_embedded_from_the_canonical_files() {
        let schema: serde_json::Value =
            serde_json::from_str(JSON_SCHEMA_SOURCE).expect("valid JSON Schema");
        assert_eq!(
            schema["$schema"],
            "https://json-schema.org/draft/2020-12/schema"
        );
        assert!(TYPESPEC_SOURCE.contains("model ApplicationDocument"));
        assert!(TYPESPEC_SOURCE.contains("model QuoteDocument"));
        assert!(POSTGRES_MIGRATION_SOURCE.contains(
            "CREATE TABLE IF NOT EXISTS fiducia_commercial.quote_versions"
        ));
        assert!(POSTGRES_MIGRATION_SOURCE.contains(
            "CREATE TABLE IF NOT EXISTS fiducia_commercial.contract_acceptances"
        ));
    }
}
