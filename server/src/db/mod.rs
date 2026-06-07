pub mod entities;

use sea_orm::{ConnectOptions, ConnectionTrait, Database as SeaDatabase, DatabaseConnection};
use std::time::Duration;

use crate::config::Config;

#[derive(Clone)]
pub struct Database {
    pub conn: DatabaseConnection,
}

impl Database {
    pub async fn connect(config: &Config) -> anyhow::Result<Self> {
        let mut options = ConnectOptions::new(config.database_url.clone());
        options
            .max_connections(16)
            .min_connections(1)
            .connect_timeout(Duration::from_secs(8))
            .sqlx_logging(false);
        let conn = SeaDatabase::connect(options).await?;
        Ok(Self { conn })
    }

    pub async fn migrate(&self) -> anyhow::Result<()> {
        self.conn
            .execute_unprepared(include_str!("../../migrations/schema.sql"))
            .await?;
        Ok(())
    }
}
