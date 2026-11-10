//! Real database drivers implementing `dbs_core::DatabaseDriver`.
//!
//! | Module   | Engines (wire-compatible)                                         |
//! |----------|-------------------------------------------------------------------|
//! | `pg`     | PostgreSQL, CockroachDB, YugabyteDB, Redshift, Greenplum           |
//! | `mysql`  | MySQL, MariaDB, Percona Server, SingleStore                        |
//! | `sqlite` | SQLite                                                             |
//! | `redis`  | Redis                                                              |
//!
//! Engines without a module here are reported as unsupported by
//! [`driver_for`]; see FEATURE_MATRIX.md.

pub mod mysql;
pub mod pg;
mod pg_types;
pub mod redis;
pub mod sqlite;
mod util;

use dbs_core::{DatabaseDriver, Engine};

pub fn driver_for(engine: Engine) -> Option<Box<dyn DatabaseDriver>> {
    match engine.wire_family()? {
        Engine::Postgres => Some(Box::new(pg::PgDriver)),
        Engine::MySql => Some(Box::new(mysql::MySqlDriver)),
        Engine::Sqlite => Some(Box::new(sqlite::SqliteDriver)),
        Engine::Redis => Some(Box::new(redis::RedisDriver)),
        _ => None,
    }
}

pub fn supported_engines() -> Vec<Engine> {
    Engine::ALL.into_iter().filter(|e| e.wire_family().is_some()).collect()
}
