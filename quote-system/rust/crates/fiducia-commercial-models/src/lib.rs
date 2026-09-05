#![forbid(unsafe_code)]

//! Feature-gated facade over the commercial contract and ORM projections.
//!
//! Consumers should enable only the persistence view they actually use. Public
//! request/response types continue to come from generated TypeSpec and JSON
//! Schema clients rather than from database row structs.

#[cfg(feature = "sql-models")]
pub use fiducia_commercial_contracts as contracts;

#[cfg(feature = "diesel-models")]
pub use fiducia_commercial_diesel as diesel;

#[cfg(feature = "seaorm-models")]
pub use fiducia_commercial_seaorm as seaorm;
