//! Decides when the user is away from the computer.
//!
//! The desktop shell feeds one [`Sample`] a second (time since the last
//! keyboard/mouse input anywhere in Windows, and whether the session is
//! locked). The tracker turns those into [`Event`]s with exact timestamps, so
//! work time can be paused from the moment of the last input and resumed from
//! the first one, no matter how late the events are processed.
//!
//! Three things count as away:
//! * no input for the idle threshold;
//! * the session is locked (after a short grace period, so a UAC prompt on the
//!   secure desktop doesn't count);
//! * the computer was asleep or suspended, which shows up as a jump between
//!   two samples.

use serde::Serialize;

/// A gap this long between two samples means the computer was suspended.
const GAP_MS: i64 = 10_000;
/// The session must stay locked this long before it counts as away.
const LOCK_GRACE_MS: i64 = 5_000;
/// Input newer than this means the user is back.
const BACK_WITHIN_MS: u64 = 3_000;
const MIN_THRESHOLD_MS: u64 = 5_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Sample {
    /// Wall clock, epoch milliseconds (used for the timestamps in events).
    pub now_ms: i64,
    /// Monotonic clock in milliseconds (used with the wall clock to notice suspends).
    pub mono_ms: u64,
    /// Milliseconds since the last keyboard or mouse input.
    pub idle_ms: u64,
    pub locked: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Reason {
    Idle,
    Locked,
    Sleep,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Event {
    /// The user went away at `since` (already in the past when this is reported).
    Away { since: i64, reason: Reason },
    /// An idle spell reached the long-idle limit (used to pause focus timers).
    LongIdle { since: i64 },
    /// The user came back at `at`.
    Back { at: i64 },
}

#[derive(Debug, Clone)]
pub struct Tracker {
    threshold_ms: u64,
    long_ms: u64,
    away: Option<(i64, Reason)>,
    long_sent: bool,
    last: Option<Sample>,
    last_active_ms: i64,
    lock_since: Option<i64>,
    last_locked_ms: Option<i64>,
}

impl Tracker {
    /// `threshold_ms`: idle time that counts as away. `long_ms`: idle time after
    /// which [`Event::LongIdle`] is reported once.
    pub fn new(threshold_ms: u64, long_ms: u64) -> Self {
        Self {
            threshold_ms: threshold_ms.max(MIN_THRESHOLD_MS),
            long_ms,
            away: None,
            long_sent: false,
            last: None,
            last_active_ms: i64::MIN,
            lock_since: None,
            last_locked_ms: None,
        }
    }

    pub fn set_threshold(&mut self, threshold_ms: u64) {
        self.threshold_ms = threshold_ms.max(MIN_THRESHOLD_MS);
    }

    /// When the user went away, if they are away now.
    pub fn away_since(&self) -> Option<i64> {
        self.away.map(|(since, _)| since)
    }

    pub fn feed(&mut self, s: Sample) -> Vec<Event> {
        let mut out = Vec::new();
        let last_input = s.now_ms - s.idle_ms as i64;

        // 1. The computer slept (or this process was frozen) between two samples.
        if let Some(prev) = self.last {
            let gap = (s.now_ms - prev.now_ms).max(s.mono_ms.saturating_sub(prev.mono_ms) as i64);
            if gap > GAP_MS && self.away.is_none() {
                let since = self.last_active_ms.min(prev.now_ms).max(prev.now_ms - self.threshold_ms as i64);
                self.away = Some((since, Reason::Sleep));
                self.long_sent = true;
                out.push(Event::Away { since, reason: Reason::Sleep });
            }
        }

        // 2. The session is locked.
        if s.locked {
            let since = *self.lock_since.get_or_insert(s.now_ms);
            self.last_locked_ms = Some(s.now_ms);
            if self.away.is_none() && s.now_ms - since >= LOCK_GRACE_MS {
                self.away = Some((since, Reason::Locked));
                self.long_sent = true;
                out.push(Event::Away { since, reason: Reason::Locked });
            }
        } else {
            self.lock_since = None;
        }

        // 3. No keyboard or mouse input for the threshold.
        if self.away.is_none() && s.idle_ms >= self.threshold_ms {
            self.away = Some((last_input, Reason::Idle));
            self.long_sent = false;
            out.push(Event::Away { since: last_input, reason: Reason::Idle });
        }
        if let Some((since, Reason::Idle)) = self.away {
            if !self.long_sent && s.idle_ms >= self.long_ms {
                self.long_sent = true;
                out.push(Event::LongIdle { since });
            }
        }

        // 4. Fresh input while unlocked: the user is back, from the moment of that input.
        if let Some((since, _)) = self.away {
            if !s.locked && s.idle_ms < BACK_WITHIN_MS {
                // Keys typed on the lock screen don't count as being back.
                let at = last_input.max(since).max(self.last_locked_ms.unwrap_or(i64::MIN)).min(s.now_ms);
                self.away = None;
                self.last_locked_ms = None;
                out.push(Event::Back { at });
            }
        }

        if self.away.is_none() {
            self.last_active_ms = self.last_active_ms.max(last_input);
        }
        self.last = Some(s);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: u64 = 60_000;
    const T0: i64 = 1_800_000_000_000;

    /// Feeds one sample a second, like the real monitor.
    struct Sim {
        tracker: Tracker,
        now: i64,
        mono: u64,
        last_input: i64,
        locked: bool,
        events: Vec<Event>,
    }

    impl Sim {
        fn new() -> Self {
            Self { tracker: Tracker::new(MIN, 5 * MIN), now: T0, mono: 0, last_input: T0, locked: false, events: vec![] }
        }
        fn sample(&mut self) {
            let s = Sample { now_ms: self.now, mono_ms: self.mono, idle_ms: (self.now - self.last_input) as u64, locked: self.locked };
            self.events.extend(self.tracker.feed(s));
        }
        /// `secs` seconds pass; `active` = the user keeps typing.
        fn run(&mut self, secs: i64, active: bool) {
            for _ in 0..secs {
                self.now += 1000;
                self.mono += 1000;
                if active {
                    self.last_input = self.now - 200;
                }
                self.sample();
            }
        }
        /// The computer sleeps: no samples at all for `secs`.
        fn sleep(&mut self, secs: i64) {
            self.now += secs * 1000;
            self.mono += secs as u64 * 1000;
        }
        fn take(&mut self) -> Vec<Event> {
            std::mem::take(&mut self.events)
        }
    }

    #[test]
    fn idle_pauses_from_the_last_input_and_resumes_from_the_first() {
        let mut s = Sim::new();
        s.run(120, true);
        assert!(s.take().is_empty());
        let stopped = s.last_input;
        s.run(59, false);
        assert!(s.take().is_empty(), "under a minute is not away");
        s.run(2, false);
        assert_eq!(s.take(), vec![Event::Away { since: stopped, reason: Reason::Idle }]);
        assert_eq!(s.tracker.away_since(), Some(stopped));
        s.run(100, false);
        assert!(s.take().is_empty(), "no repeats while away");
        s.run(1, true);
        assert_eq!(s.take(), vec![Event::Back { at: s.last_input }]);
        assert_eq!(s.tracker.away_since(), None);
    }

    #[test]
    fn long_idle_is_reported_once() {
        let mut s = Sim::new();
        s.run(10, true);
        let stopped = s.last_input;
        s.run(299, false);
        assert_eq!(s.take(), vec![Event::Away { since: stopped, reason: Reason::Idle }]);
        s.run(600, false);
        assert_eq!(s.take(), vec![Event::LongIdle { since: stopped }]);
    }

    #[test]
    fn short_breaks_in_typing_never_count_as_away() {
        let mut s = Sim::new();
        for _ in 0..20 {
            s.run(30, true);
            s.run(50, false);
        }
        assert!(s.take().is_empty());
    }

    #[test]
    fn locking_counts_as_away_from_the_moment_of_the_lock() {
        let mut s = Sim::new();
        s.run(30, true);
        s.locked = true;
        s.run(1, true);
        let locked_at = s.now;
        s.run(10, true); // typing the password on the lock screen
        assert_eq!(s.take(), vec![Event::Away { since: locked_at, reason: Reason::Locked }]);
        s.run(300, false);
        s.run(5, true);
        assert!(s.take().is_empty(), "never back while locked");
        let last_locked = s.now;
        s.locked = false;
        s.run(1, true);
        assert_eq!(s.take(), vec![Event::Back { at: last_locked.max(s.last_input) }]);
    }

    #[test]
    fn a_brief_secure_desktop_prompt_is_ignored() {
        let mut s = Sim::new();
        s.run(30, true);
        s.locked = true;
        s.run(3, true);
        s.locked = false;
        s.run(30, true);
        assert!(s.take().is_empty());
    }

    #[test]
    fn sleep_is_excluded_even_when_a_key_press_wakes_the_computer() {
        let mut s = Sim::new();
        s.run(60, true);
        let before = s.now;
        s.sleep(8 * 3600);
        s.run(1, true); // the waking key press is the first thing seen
        let ev = s.take();
        assert_eq!(ev.len(), 2);
        match (ev[0], ev[1]) {
            (Event::Away { since, reason: Reason::Sleep }, Event::Back { at }) => {
                assert!(since <= before && since >= before - 1000, "away starts where the samples stopped");
                assert!(at > before + 8 * 3600 * 1000 - 1, "back only after the sleep");
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn after_sleep_without_input_the_user_stays_away() {
        let mut s = Sim::new();
        s.run(60, true);
        s.sleep(3600);
        s.run(30, false); // woke on a timer, nobody there
        let ev = s.take();
        assert_eq!(ev.len(), 1);
        assert!(matches!(ev[0], Event::Away { reason: Reason::Sleep, .. }));
        s.run(1, true);
        assert_eq!(s.take(), vec![Event::Back { at: s.last_input }]);
    }

    #[test]
    fn sleeping_while_already_away_keeps_the_original_start() {
        let mut s = Sim::new();
        s.run(10, true);
        let stopped = s.last_input;
        s.run(90, false);
        assert_eq!(s.take(), vec![Event::Away { since: stopped, reason: Reason::Idle }]);
        s.sleep(3600);
        s.run(5, false);
        // Still the same absence: no second "away", only the long-idle notice.
        assert_eq!(s.take(), vec![Event::LongIdle { since: stopped }]);
        assert_eq!(s.tracker.away_since(), Some(stopped));
    }

    #[test]
    fn the_threshold_can_change_and_has_a_floor() {
        let mut s = Sim::new();
        s.tracker.set_threshold(10 * MIN);
        s.run(10, true);
        s.run(9 * 60, false);
        assert!(s.take().is_empty());
        s.tracker.set_threshold(0);
        s.run(1, false);
        assert!(matches!(s.take()[0], Event::Away { reason: Reason::Idle, .. }));
    }

    #[test]
    fn events_serialise_for_the_ui() {
        let j = serde_json::to_string(&Event::Away { since: 5, reason: Reason::Locked }).unwrap();
        assert_eq!(j, r#"{"kind":"away","since":5,"reason":"locked"}"#);
        assert_eq!(serde_json::to_string(&Event::LongIdle { since: 7 }).unwrap(), r#"{"kind":"longIdle","since":7}"#);
        assert_eq!(serde_json::to_string(&Event::Back { at: 9 }).unwrap(), r#"{"kind":"back","at":9}"#);
    }
}
