//! Auto Typer playback: replays a planned list of key presses and releases in
//! real time. The plan itself is built by the UI (`src/lib/typer/engine.ts`).
//!
//! Everything that touches the operating system goes through [`Host`], so the
//! timing, pause/resume and "never leave a key held down" rules can be tested
//! without sending real keystrokes.

use serde::Deserialize;

/// One planned key transition. `key` is a single character or a name such as
/// `<shift>`, `<mod>` (Ctrl), `<backspace>`, `<delete>`, `<left>`, `<right>`,
/// `<enter>`, `<tab>`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct PlanEvent {
    /// Seconds from the start of typing.
    pub t: f64,
    pub down: bool,
    pub key: String,
}

/// What the player needs from the outside world.
pub trait Host {
    fn key(&mut self, key: &str, down: bool);
    /// False while typing must hold, e.g. the target window lost focus.
    fn can_type(&mut self) -> bool;
    /// True once the user asked to stop.
    fn stopped(&mut self) -> bool;
    /// Monotonic clock in seconds.
    fn now(&mut self) -> f64;
    fn sleep(&mut self, seconds: f64);
    fn paused(&mut self, _paused: bool) {}
    /// Called after each event with how many of `total` have played.
    fn progress(&mut self, _done: usize, _total: usize) {}
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Finished,
    Stopped,
}

const MODIFIERS: [&str; 2] = ["<shift>", "<mod>"];
/// Longest single sleep, so a stop request is noticed quickly.
const SLICE: f64 = 0.02;
/// Pause after the target comes back before typing again.
const SETTLE: f64 = 0.4;

fn release_all<H: Host>(host: &mut H, down: &mut Vec<String>) {
    while let Some(k) = down.pop() {
        host.key(&k, false);
    }
}

/// Sleep until `deadline`; returns false if a stop was requested first.
fn wait_until<H: Host>(host: &mut H, deadline: f64) -> bool {
    loop {
        if host.stopped() {
            return false;
        }
        let left = deadline - host.now();
        if left <= 0.0 {
            return true;
        }
        host.sleep(left.min(SLICE));
    }
}

/// Replay `events` (sorted by time). Whatever happens, every key that was
/// pressed is released before this returns.
pub fn play<H: Host>(events: &[PlanEvent], host: &mut H) -> Outcome {
    let mut down: Vec<String> = Vec::new();
    let mut start = host.now();
    for (i, e) in events.iter().enumerate() {
        let at = if e.t.is_finite() { e.t.max(0.0) } else { 0.0 };
        if !wait_until(host, start + at) {
            release_all(host, &mut down);
            return Outcome::Stopped;
        }
        if e.down {
            if !host.can_type() {
                // Let go of everything, wait for the target, then carry on from the same place.
                let mods: Vec<String> = down.iter().filter(|k| MODIFIERS.contains(&k.as_str())).cloned().collect();
                release_all(host, &mut down);
                let paused_at = host.now();
                host.paused(true);
                loop {
                    if host.stopped() {
                        return Outcome::Stopped;
                    }
                    if host.can_type() {
                        break;
                    }
                    host.sleep(0.2);
                }
                host.paused(false);
                let settle = host.now() + SETTLE;
                if !wait_until(host, settle) {
                    return Outcome::Stopped;
                }
                start += host.now() - paused_at;
                for k in mods {
                    host.key(&k, true);
                    down.push(k);
                }
            }
            if !down.contains(&e.key) {
                host.key(&e.key, true);
                down.push(e.key.clone());
            }
        } else if let Some(pos) = down.iter().position(|k| k == &e.key) {
            host.key(&e.key, false);
            down.remove(pos);
        }
        host.progress(i + 1, events.len());
    }
    release_all(host, &mut down);
    Outcome::Finished
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct Fake {
        clock: f64,
        log: Vec<(f64, String, bool)>,
        /// Times between which the target is out of focus.
        away: Vec<(f64, f64)>,
        stop_at: Option<f64>,
        pauses: Vec<bool>,
        done: usize,
    }

    impl Host for Fake {
        fn key(&mut self, key: &str, down: bool) {
            assert!(!down || self.can_type(), "typed {key} while the target was away");
            self.log.push((self.clock, key.to_string(), down));
        }
        fn can_type(&mut self) -> bool {
            !self.away.iter().any(|(a, b)| self.clock >= *a && self.clock < *b)
        }
        fn stopped(&mut self) -> bool {
            self.stop_at.is_some_and(|t| self.clock >= t)
        }
        fn now(&mut self) -> f64 {
            self.clock
        }
        fn sleep(&mut self, seconds: f64) {
            self.clock += seconds;
        }
        fn paused(&mut self, paused: bool) {
            self.pauses.push(paused);
        }
        fn progress(&mut self, done: usize, _total: usize) {
            self.done = done;
        }
    }

    fn ev(t: f64, down: bool, key: &str) -> PlanEvent {
        PlanEvent { t, down, key: key.into() }
    }

    fn held(log: &[(f64, String, bool)]) -> Vec<String> {
        let mut down: Vec<String> = vec![];
        for (_, k, d) in log {
            if *d {
                assert!(!down.contains(k), "{k} pressed twice");
                down.push(k.clone());
            } else {
                let pos = down.iter().position(|x| x == k).unwrap_or_else(|| panic!("{k} released while up"));
                down.remove(pos);
            }
        }
        down
    }

    fn plan() -> Vec<PlanEvent> {
        vec![
            ev(0.0, true, "<shift>"),
            ev(0.05, true, "h"),
            ev(0.12, false, "h"),
            ev(0.15, false, "<shift>"),
            ev(0.30, true, "i"),
            ev(0.34, true, "!"), // overlaps "i"
            ev(0.38, false, "i"),
            ev(0.42, false, "!"),
        ]
    }

    #[test]
    fn plays_in_order_at_the_planned_times() {
        let mut h = Fake::default();
        assert_eq!(play(&plan(), &mut h), Outcome::Finished);
        let keys: Vec<(String, bool)> = h.log.iter().map(|(_, k, d)| (k.clone(), *d)).collect();
        let want: Vec<(String, bool)> = plan().iter().map(|e| (e.key.clone(), e.down)).collect();
        assert_eq!(keys, want);
        for ((at, _, _), e) in h.log.iter().zip(plan()) {
            assert!(*at >= e.t - 1e-9 && *at < e.t + SLICE + 1e-9, "played at {at}, planned {}", e.t);
        }
        assert!(held(&h.log).is_empty());
        assert_eq!(h.done, plan().len());
    }

    #[test]
    fn stopping_releases_every_held_key() {
        for stop in [0.0, 0.06, 0.13, 0.31, 0.35, 0.40] {
            let mut h = Fake { stop_at: Some(stop), ..Default::default() };
            assert_eq!(play(&plan(), &mut h), Outcome::Stopped, "stop at {stop}");
            assert!(held(&h.log).is_empty(), "keys left down after stopping at {stop}");
            assert!(h.log.iter().filter(|(_, _, d)| *d).all(|(t, _, _)| *t < stop + 1e-9));
        }
    }

    #[test]
    fn holds_while_the_target_is_away_and_resumes_with_modifiers() {
        // The target disappears while Shift is held, before "h" is pressed.
        let mut h = Fake { away: vec![(0.03, 5.0)], ..Default::default() };
        assert_eq!(play(&plan(), &mut h), Outcome::Finished);
        assert_eq!(h.pauses, vec![true, false]);
        assert!(held(&h.log).is_empty());
        // Shift was let go for the pause and pressed again before "h".
        let names: Vec<String> = h.log.iter().map(|(_, k, d)| format!("{}{}", if *d { "+" } else { "-" }, k)).collect();
        assert_eq!(&names[..4], ["+<shift>", "-<shift>", "+<shift>", "+h"]);
        // Nothing was typed while away, and the rest keeps its rhythm.
        let h_down = h.log.iter().find(|(_, k, d)| k == "h" && *d).unwrap().0;
        assert!(h_down >= 5.0 + SETTLE - 1e-9);
        let i_down = h.log.iter().find(|(_, k, d)| k == "i" && *d).unwrap().0;
        assert!((i_down - h_down - 0.25).abs() < 2.0 * SLICE, "gap {} should stay about 0.25", i_down - h_down);
    }

    #[test]
    fn stop_while_away_presses_nothing_more() {
        let mut h = Fake { away: vec![(0.03, 100.0)], stop_at: Some(2.0), ..Default::default() };
        assert_eq!(play(&plan(), &mut h), Outcome::Stopped);
        assert!(held(&h.log).is_empty());
        assert_eq!(h.log.len(), 2); // Shift down, Shift up
    }

    #[test]
    fn tolerates_a_malformed_plan() {
        let weird = vec![ev(f64::NAN, true, "a"), ev(-3.0, true, "a"), ev(0.01, false, "zz"), ev(0.02, true, "b")];
        let mut h = Fake::default();
        assert_eq!(play(&weird, &mut h), Outcome::Finished);
        assert!(held(&h.log).is_empty());
        assert_eq!(h.log.iter().filter(|(_, k, d)| k == "a" && *d).count(), 1);
    }
}
