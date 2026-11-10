//! Production safe mode.
//!
//! Three layers, in order of strength:
//! 1. **Database-enforced read-only sessions** (set by the session manager when a
//!    connection is marked read-only; see `DatabaseConnection::set_read_only`).
//! 2. **Policy enforcement in the backend** (this crate): every user-authored
//!    script is lexed, split into statements, classified, and checked against the
//!    connection's policy before it reaches the driver. Risky statements require
//!    a confirmation token bound to the exact SQL text.
//! 3. UI warnings (frontend), which are advisory only.
//!
//! A client-side classifier cannot prove a statement harmless: functions,
//! procedures, triggers and dynamic SQL can write. Anything we cannot classify
//! with confidence is reported as `Unknown` and treated as a write.

pub mod lexer;
pub mod classify;
pub mod policy;

pub use classify::*;
pub use lexer::*;
pub use policy::*;
