use std::{cell::UnsafeCell, path::PathBuf};

use clap::{Parser, ValueEnum};
use figment::providers::Format;
use ott_balancer_protocol::Region;
use serde::Deserialize;

use ott_common::discovery::DiscoveryConfig;

use crate::selection::MonolithSelectionConfig;

/// The config is written once during single-threaded startup (or by tests and benchmarks
/// before any reader exists) and read concurrently afterwards. Writing it through a shared
/// reference is what this type documents; the previous `&T`-to-`&mut T` cast did the same
/// thing implicitly, which current rustc rejects as undefined behaviour.
struct ConfigCell(UnsafeCell<Option<BalancerConfig>>);

// SAFETY: the value is only written before readers run (startup, or a test's setup phase),
// and never mutated once `get()` has handed out a reference.
unsafe impl Sync for ConfigCell {}

static CONFIG: ConfigCell = ConfigCell(UnsafeCell::new(None));

impl ConfigCell {
    fn set(&self, config: BalancerConfig) {
        // SAFETY: single-threaded startup; see the type comment.
        let slot = unsafe { &mut *self.0.get() };
        // A second load keeps the first winner, matching the previous Once semantics.
        if slot.is_none() {
            *slot = Some(config);
        }
    }

    fn get(&self) -> Option<&'static BalancerConfig> {
        // SAFETY: the slot lives for the program's lifetime and is never written again.
        unsafe { (*self.0.get()).as_ref() }
    }

    fn get_mut(&self) -> Option<&'static mut BalancerConfig> {
        // SAFETY: only reachable in single-threaded setup; see the type comment.
        unsafe { (*self.0.get()).as_mut() }
    }
}

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
        CONFIG.set(config);
        Ok(())
    }

    /// Initialize the config with default values.
    pub fn init_default() {
        CONFIG.set(BalancerConfig::default());
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
        // SAFETY: see the doc comment above; the cell is only touched during single-threaded
        // setup, before any `get()` reference is shared.
        CONFIG.get_mut().expect("config not initialized")
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
