//! Target input evidence, independent of delivery. Unknown evidence is sticky:
//! a new host (not a retry or a quiet interval) is needed after an observer gap.

use std::collections::HashMap;

pub const UNAVAILABLE: &str = "target_input_observation_unavailable";
pub const CLEANUP_UNCONFIRMED: &str = "input_cleanup_unconfirmed";
const MAX_SEQUENCE: i64 = 9_007_199_254_740_991;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct Process {
    pub pid: i32,
    pub seconds: u64,
    pub micros: u64,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct Family {
    pub process: Process,
    pub parent: Option<Process>,
}

impl Family {
    fn related(self, other: Self) -> bool {
        self.process == other.process
            || self.parent == Some(other.process)
            || other.parent == Some(self.process)
    }
}

pub struct Ledger {
    pub generation: String,
    started: bool,
    failure: Option<String>,
    sequences: HashMap<Family, i64>,
}

/// Only owned, not-yet-released input is eligible for cleanup. The payload is
/// a retained native event on macOS; tests exercise the same bookkeeping with
/// inert values, without posting physical input.
pub struct Held<T>(Vec<((u32, i64), T)>);

impl<T> Default for Held<T> {
    fn default() -> Self { Self(Vec::new()) }
}

impl<T> Held<T> {
    pub fn down(&mut self, release: (u32, i64), event: T) {
        self.0.push((release, event));
    }

    pub fn up(&mut self, release: (u32, i64)) -> Option<T> {
        let index = self.0.iter().rposition(|(key, _)| *key == release)?;
        Some(self.0.remove(index).1)
    }

    pub fn releases(self) -> impl Iterator<Item = ((u32, i64), T)> {
        self.0.into_iter().rev()
    }

    /// A void native posting function cannot acknowledge cleanup. Attempt all
    /// owned releases, then require explicit user recovery if any were needed.
    pub fn cleanup(self, mut release: impl FnMut((u32, i64), T)) -> Result<(), String> {
        let mut unconfirmed = false;
        for (key, event) in self.releases() {
            unconfirmed = true;
            release(key, event);
        }
        if unconfirmed {
            Err(format!("{CLEANUP_UNCONFIRMED}: owned background input release cannot be acknowledged; manual recovery required; do not replay input"))
        } else {
            Ok(())
        }
    }
}

impl Ledger {
    pub fn new(generation: String) -> Self {
        Self { generation, started: false, failure: None, sequences: HashMap::new() }
    }

    pub fn start(&mut self) {
        self.started = true;
    }

    pub fn lose(&mut self, reason: &str) {
        self.failure.get_or_insert_with(|| reason.into());
    }

    pub fn record(&mut self, own: bool, destination: Option<Family>) {
        if own {
            return;
        }
        let Some(destination) = destination else {
            self.lose("event destination or process identity is unknown; restart observer");
            return;
        };
        let mut exhausted = false;
        for (family, sequence) in &mut self.sequences {
            if family.related(destination) {
                if *sequence == MAX_SEQUENCE {
                    exhausted = true;
                } else {
                    *sequence += 1;
                }
            }
        }
        if exhausted {
            self.lose("target input sequence exhausted; restart observer");
        }
    }

    pub fn observe(&mut self, family: Family) -> Result<(String, i64), String> {
        if let Some(reason) = &self.failure {
            return Err(format!("{UNAVAILABLE}: {reason}"));
        }
        if !self.started {
            return Err(format!("{UNAVAILABLE}: target event tap is not ready"));
        }
        let sequence = *self.sequences.entry(family).or_default();
        // Include both incarnations: a reused parent PID is not a relationship.
        Ok((format!("{}:{:?}", self.generation, family), sequence))
    }

    pub fn check(&mut self, family: Family, monitor: &str, sequence: i64) -> Result<(), String> {
        let (current, observed) = self.observe(family)?;
        if current != monitor || !(0..=MAX_SEQUENCE).contains(&sequence) {
            return Err(format!("{UNAVAILABLE}: target identity or observer generation changed"));
        }
        if observed != sequence {
            return Err("user_input_active: target input superseded observation; refresh without replay".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn family(pid: i32, parent: Option<Process>) -> Family {
        Family { process: Process { pid, seconds: 1, micros: 0 }, parent }
    }

    fn ledger() -> Ledger {
        let mut ledger = Ledger::new("observer".into());
        ledger.start();
        ledger
    }

    #[test]
    fn unrelated_input_does_not_supersede_target_but_target_and_auxiliary_windows_do() {
        let mut ledger = ledger();
        let app = family(10, None);
        let (monitor, sequence) = ledger.observe(app).unwrap();
        ledger.record(false, Some(family(20, None)));
        ledger.record(true, Some(app));
        ledger.check(app, &monitor, sequence).unwrap();
        // All windows of the same process share one family.
        ledger.record(false, Some(app));
        assert!(ledger.check(app, &monitor, sequence).unwrap_err().starts_with("user_input_active:"));
        assert!(ledger.check(app, &monitor, sequence).is_err()); // no replay grant
        let (fresh, sequence) = ledger.observe(app).unwrap();
        ledger.check(app, &fresh, sequence).unwrap();
    }

    #[test]
    fn related_processes_are_bound_to_incarnations_not_reused_pids_or_siblings() {
        let mut ledger = ledger();
        let app = family(10, None);
        let (monitor, sequence) = ledger.observe(app).unwrap();
        ledger.record(false, Some(family(11, Some(app.process))));
        assert!(ledger.check(app, &monitor, sequence).is_err());
        let (_, sequence) = ledger.observe(app).unwrap();
        let reused = Process { seconds: 2, ..app.process };
        ledger.record(false, Some(family(12, Some(reused))));
        ledger.check(app, &monitor, sequence).unwrap();
        assert!(ledger.check(Family { process: reused, parent: None }, &monitor, sequence).is_err());
    }

    #[test]
    fn unknown_and_tap_gaps_cannot_be_hidden_by_resume_or_own_events() {
        for reason in [None, Some("event tap disabled")] {
            let mut ledger = ledger();
            let app = family(10, None);
            let (monitor, sequence) = ledger.observe(app).unwrap();
            if let Some(reason) = reason {
                ledger.lose(reason);
            } else {
                ledger.record(false, None);
            }
            ledger.start();
            ledger.record(true, Some(app));
            ledger.record(false, Some(family(20, None)));
            assert!(ledger.check(app, &monitor, sequence).unwrap_err().starts_with(UNAVAILABLE));
            assert!(ledger.observe(app).is_err());
        }
    }

    #[test]
    fn stale_generation_and_unsafe_sequence_refuse() {
        let mut ledger = ledger();
        let app = family(10, None);
        let (monitor, _) = ledger.observe(app).unwrap();
        assert!(ledger.check(app, "other", 0).is_err());
        assert!(ledger.check(app, &monitor, -1).is_err());
        assert!(ledger.check(app, &monitor, MAX_SEQUENCE + 1).is_err());
        ledger.sequences.insert(app, MAX_SEQUENCE);
        ledger.record(false, Some(app));
        assert!(ledger.observe(app).is_err());
    }

    #[test]
    fn interruption_cleanup_releases_only_owned_pending_input_without_replay() {
        let mut held = Held::default();
        held.down((11, 56), "modifier-up");
        held.down((11, 0), "character-up");
        held.down((2, 0), "pointer-up");
        assert_eq!(held.up((11, 0)), Some("character-up"));
        assert_eq!(held.up((11, 12)), None); // not owned, never synthesize release
        assert_eq!(held.releases().collect::<Vec<_>>(), vec![
            ((2, 0), "pointer-up"), ((11, 56), "modifier-up"),
        ]);
        // Consuming the queue means cleanup cannot be replayed.
    }

    #[test]
    fn void_cleanup_never_claims_confirmation_even_when_posting_returns() {
        let mut held = Held::default();
        held.down((11, 56), "modifier");
        held.down((2, 0), "pointer");
        let mut attempts = Vec::new();
        let error = held.cleanup(|key, event| attempts.push((key, event))).unwrap_err();
        assert!(error.starts_with("input_cleanup_unconfirmed:"));
        assert_eq!(attempts, vec![((2, 0), "pointer"), ((11, 56), "modifier")]);
        Held::<()>::default().cleanup(|_, _| panic!("no owned input")).unwrap();
    }
}
