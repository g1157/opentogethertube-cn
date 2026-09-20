use std::{path::PathBuf, sync::OnceLock};

use clap::{Parser, ValueEnum};
use figment::providers::Format;
use ott_balancer_protocol::Region;
use serde::Deserialize;

use ott_common::discovery::DiscoveryConfig;

use crate::selection::MonolithSelectionConfig;

static CONFIG: OnceLock<BalancerConfig> = OnceLock::new();

#[derive(Debug, Deserialize)]
#[serde(default)]
pub struct BalancerConfig {
    /// The port to listen on for HTTP requests.
    pub port: u16,
    pub discovery: DiscoveryConfig,
    pub region: Region,
    /// The API key that clients can use to access restricted endpoints.
    pub api_key: Option<String>,
    pub selection_strategy: Option<MonolithSelectionConfig>,
}

impl Default for BalancerConfig {
    fn default() -> Self {
        Self {
            port: 8081,
            discovery: DiscoveryConfig::default(),
            region: Default::default(),
            api_key: None,
            selection_strategy: None,
        }
    }
}

impl BalancerConfig {
    pub fn load(path: &PathBuf) -> Result<(), anyhow::Error> {
        let mut config: BalancerConfig = figment::Figment::new()
            .merge(figment::providers::Toml::file(path))
            .merge(figment::providers::Env::prefixed("BALANCER_"))
            .extract()?;

        if let Some(region) = figment::providers::Env::var("FLY_REGION") {
            config.region = region.into();
        }
        // A second load keeps the first winner, matching the previous Once semantics.
        let _ = CONFIG.set(config);
        Ok(())
    }

    /// Initialize the config with default values.
    pub fn init_default() {
        let _ = CONFIG.set(BalancerConfig::default());
    }

    pub fn get() -> &'static Self {
        debug_assert!(CONFIG.get().is_some(), "config not initialized");
        CONFIG.get().expect("config not initialized")
    }

    /// Get a mutable reference to the config. Should only be used for tests and benchmarks.
    ///
    /// # Safety
    ///
    /// Must be called before any concurrent `get()` shares the reference; benchmarks
    /// only use this during single-threaded setup.
    pub fn get_mut() -> &'static mut Self {
        debug_assert!(CONFIG.get().is_some(), "config not initialized");
        // SAFETY: see doc comment above; single-threaded setup casts away constness.
        let ptr = CONFIG.get().expect("config not initialized") as *const Self as *mut Self;
        unsafe { &mut *ptr }
    }
}

#[derive(Debug, Parser)]
pub struct Cli {
    #[clap(short, long, default_value = "balancer.toml")]
    pub config_path: PathBuf,

    #[clap(short, long, default_value_t = LogLevel::Info, value_enum)]
    pub log_level: LogLevel,

    /// Enable the console-subscriber for debugging via tokio-console.
    #[clap(long)]
    pub console: bool,

    /// Allow remote connections via tokio-console for debugging. By default, only local connections are allowed.
    ///
    /// The default port for tokio-console is 6669.
    #[clap(long, requires("console"))]
    pub remote_console: bool,

    /// Validate the configuration file.
    #[clap(long, short)]
    pub validate: bool,
}

impl Cli {
    pub fn build_tracing_filter(&self) -> String {
        self.log_level.into()
    }
}

#[derive(ValueEnum, Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[clap(rename_all = "lowercase")]
#[derive(Default)]
pub enum LogLevel {
    Trace,
    Debug,
    #[default]
    Info,
    Warn,
    Error,
}

impl From<LogLevel> for String {
    fn from(val: LogLevel) -> Self {
        match val {
            LogLevel::Trace => "trace",
            LogLevel::Debug => "debug",
            LogLevel::Info => "info",
            LogLevel::Warn => "warn",
            LogLevel::Error => "error",
        }
        .into()
    }
}

impl From<LogLevel> for tracing::Level {
    fn from(val: LogLevel) -> Self {
        match val {
            LogLevel::Trace => Self::TRACE,
            LogLevel::Debug => Self::DEBUG,
            LogLevel::Info => Self::INFO,
            LogLevel::Warn => Self::WARN,
            LogLevel::Error => Self::ERROR,
        }
    }
}
