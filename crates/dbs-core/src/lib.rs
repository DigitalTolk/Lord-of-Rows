//! Core types shared by every layer: values, results, metadata, configuration,
//! the `DatabaseDriver` trait, capabilities, and dialect-aware identifier quoting.
//!
//! Nothing in this crate touches the network, filesystem, or UI.

pub mod config;
pub mod dialect;
pub mod driver;
pub mod error;
pub mod meta;
pub mod stream;
pub mod value;

pub use config::*;
pub use dialect::*;
pub use driver::*;
pub use error::*;
pub use meta::*;
pub use stream::*;
pub use value::*;
