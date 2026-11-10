//! Streaming import/export.
//!
//! Export writes rows incrementally to any `Write` (file, gzip encoder,
//! clipboard buffer), so memory stays bounded by one batch of rows.
//! Import parses CSV/TSV/JSON/JSONL with a preview, type inference and
//! bounded batch size; the caller inserts each batch with parameterised SQL.

pub mod export;
pub mod import;

pub use export::*;
pub use import::*;
