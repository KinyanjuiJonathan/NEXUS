//! Restarts, reboots, failed loads and recovery: the data must survive all of them.

use std::path::Path;

use nexus_core::recovery::{list_backups, open_checked, restore_into, set_aside, start_fresh, validate_backup, Problem};
use nexus_core::{CalendarEvent, Store, Task};
use serde_json::json;

fn task(id: &str, title: &str) -> Task {
    serde_json::from_value(json!({
        "id": id, "title": title, "notes": "", "priority": "medium", "categoryId": "work", "status": "todo",
        "dueAt": null, "dueTz": null, "estimateMin": 60, "spentMs": 0, "sortOrder": 1.0, "recurrence": null,
        "reminders": [], "subtasks": [], "completedAt": null, "archivedAt": null, "deletedAt": null,
        "createdAt": 1, "updatedAt": 1
    }))
    .unwrap()
}

fn event(id: &str, title: &str, task_id: Option<&str>) -> CalendarEvent {
    serde_json::from_value(json!({
        "id": id, "title": title, "notes": "", "startAt": 1_000, "endAt": 2_000, "tz": "Africa/Nairobi",
        "taskId": task_id, "recurrence": null, "important": false, "reminders": [], "color": null,
        "fixed": task_id.is_none(), "sched": { "origin": "smart", "request": "Write the report today, 1 hour" },
        "createdAt": 1, "updatedAt": 1, "deletedAt": null
    }))
    .unwrap()
}

/// A database with a bit of everything in it.
fn fill(s: &mut Store) {
    s.upsert_task(&task("t1", "Write report")).unwrap();
    let mut done = task("t2", "Send invoice");
    done.status = "done".into();
    done.completed_at = Some(5);
    s.upsert_task(&done).unwrap();
    s.upsert_event(&event("e1", "Write report", Some("t1"))).unwrap();
    s.upsert_event(&event("e2", "Client call", None)).unwrap();
    s.set_setting("homeZone", &json!("Africa/Nairobi")).unwrap();
    s.set_setting("routine", &json!({ "enabled": true, "wake": 390 })).unwrap();
    s.sync_reminders("task", "t1", &[serde_json::from_value(json!({ "title": "Write report", "body": "", "fireAt": 9_999_999_999_999i64 })).unwrap()]).unwrap();
}

fn titles(s: &Store) -> (Vec<String>, Vec<String>) {
    let snap = s.load_snapshot().unwrap();
    let mut t: Vec<String> = snap.tasks.iter().map(|x| x.title.clone()).collect();
    let mut e: Vec<String> = snap.events.iter().map(|x| x.title.clone()).collect();
    t.sort();
    e.sort();
    (t, e)
}

fn assert_everything(s: &Store) {
    let (t, e) = titles(s);
    assert_eq!(t, vec!["Send invoice", "Write report"]);
    assert_eq!(e, vec!["Client call", "Write report"]);
    let snap = s.load_snapshot().unwrap();
    assert_eq!(snap.settings["homeZone"], json!("Africa/Nairobi"), "preferences");
    assert_eq!(snap.settings["routine"]["wake"], json!(390));
    assert_eq!(snap.tasks.iter().find(|x| x.id == "t2").unwrap().completed_at, Some(5), "completed-task history");
    let ai = snap.events.iter().find(|x| x.id == "e1").unwrap();
    assert_eq!(ai.sched.as_ref().unwrap()["request"], json!("Write the report today, 1 hour"), "AI schedule details");
    assert_eq!(s.upcoming_reminders(0, 10).unwrap().len(), 1, "reminders");
    assert!(s.quick_check().unwrap());
}

fn bytes(p: &Path) -> Vec<u8> {
    std::fs::read(p).unwrap()
}

#[test]
fn data_survives_closing_and_reopening_many_times() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("nexus.db");
    let backups = dir.path().join("backups");
    {
        let mut s = open_checked(&db, &backups).expect("first run creates the database");
        fill(&mut s);
    }
    for _ in 0..5 {
        let s = open_checked(&db, &backups).expect("reopens");
        assert_everything(&s);
    }
}

#[test]
fn data_survives_a_reboot_that_never_closed_the_app() {
    // Windows shutting down kills the process: the connection is never closed,
    // and what was written last is still only in the write-ahead log.
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("nexus.db");
    let backups = dir.path().join("backups");
    let mut s = open_checked(&db, &backups).unwrap();
    fill(&mut s);
    std::mem::forget(s); // no clean close, no checkpoint
    assert!(Path::new(&format!("{}-wal", db.display())).exists(), "changes are still in the write-ahead log");
    let again = open_checked(&db, &backups).expect("opens after the reboot");
    assert_everything(&again);
    // a checkpoint folds the log into the main file
    again.checkpoint().unwrap();
    assert_everything(&again);
}

#[test]
fn a_missing_database_with_backups_is_never_replaced_by_an_empty_one() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("nexus.db");
    let backups = dir.path().join("backups");
    {
        let mut s = open_checked(&db, &backups).unwrap();
        fill(&mut s);
        s.auto_backup(&backups, 7, 1_800_000_000_000).unwrap().expect("a backup is written");
    }
    std::fs::remove_file(&db).unwrap();
    let fail = open_checked(&db, &backups).err().expect("refuses to start empty");
    assert_eq!(fail.problem, Problem::Missing);
    assert!(!db.exists(), "no empty database was created in its place");

    // the backup brings everything back
    let found = list_backups(&backups);
    assert_eq!(found.len(), 1);
    assert!(found[0].valid);
    assert_eq!((found[0].tasks, found[0].events), (Some(2), Some(2)));
    let (s, aside) = restore_into(&db, Path::new(&found[0].path), &backups, 1_800_000_100_000).unwrap();
    assert!(aside.is_none(), "there was nothing to set aside");
    assert_everything(&s);
}

#[test]
fn a_damaged_database_is_left_untouched_and_can_be_recovered_from_a_backup() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("nexus.db");
    let backups = dir.path().join("backups");
    {
        let mut s = open_checked(&db, &backups).unwrap();
        fill(&mut s);
        s.auto_backup(&backups, 7, 1_800_000_000_000).unwrap();
        s.checkpoint().unwrap();
    }
    for p in [format!("{}-wal", db.display()), format!("{}-shm", db.display())] {
        let _ = std::fs::remove_file(p);
    }
    // the file is overwritten with rubbish (disk fault, interrupted write)
    std::fs::write(&db, b"this is not a database, it only sits where one used to be").unwrap();
    let before = bytes(&db);
    let fail = open_checked(&db, &backups).err().expect("refuses a damaged database");
    assert!(matches!(fail.problem, Problem::Unreadable | Problem::Corrupt));
    assert_eq!(bytes(&db), before, "the damaged file was not modified, let alone emptied");

    // a file that is not a NEXUS backup is refused before anything is touched
    let junk = dir.path().join("junk.db");
    std::fs::write(&junk, b"nope").unwrap();
    assert!(validate_backup(&junk).is_err());
    assert!(restore_into(&db, &junk, &backups, 1).is_err());
    assert_eq!(bytes(&db), before);

    let backup = list_backups(&backups).into_iter().find(|b| b.name.starts_with("nexus-auto-")).unwrap();
    let (s, aside) = restore_into(&db, Path::new(&backup.path), &backups, 1_800_000_200_000).unwrap();
    assert_everything(&s);
    // the damaged original is kept, byte for byte, for a second opinion
    let aside = aside.expect("the damaged file was set aside, not deleted");
    assert_eq!(bytes(&aside), before);
    drop(s);
    assert_everything(&open_checked(&db, &backups).unwrap());
}

#[test]
fn starting_fresh_and_setting_aside_never_delete_the_old_data() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("nexus.db");
    let backups = dir.path().join("backups");
    {
        let mut s = open_checked(&db, &backups).unwrap();
        fill(&mut s);
    }
    let (fresh, aside) = start_fresh(&db, &backups, 1_800_000_300_000).unwrap();
    assert!(fresh.load_snapshot().unwrap().tasks.is_empty());
    drop(fresh);
    // everything that was there can still be opened from the copy that was set aside
    let aside = aside.expect("old data kept");
    assert_everything(&Store::open(&aside).unwrap());
    // and it can be put back
    let (s, second) = restore_into(&db, &aside, &backups, 1_800_000_400_000).unwrap();
    assert_everything(&s);
    assert!(second.is_some(), "the empty database was set aside as well");
    assert!(set_aside(&dir.path().join("absent.db"), &backups, 1).unwrap().is_none());
}

#[test]
fn backups_roll_in_two_sets_and_only_remove_their_own_files() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("nexus.db");
    let backups = dir.path().join("backups");
    let mut s = Store::open(&db).unwrap();
    fill(&mut s);
    s.backup_to(backups.join("nexus-manual-keep.db")).unwrap();
    let hour = 3600 * 1000i64;
    let t0 = 1_800_000_000_000i64;
    let mut daily = 0;
    let mut recent = 0;
    for h in 0..(24 * 10) {
        let now = t0 + h * hour;
        if s.auto_backup(&backups, 3, now).unwrap().is_some() {
            daily += 1;
        }
        if s.recent_backup(&backups, 4, now).unwrap().is_some() {
            recent += 1;
        }
    }
    assert_eq!(daily, 12, "one every 20 hours");
    assert_eq!(recent, 80, "one every 3 hours");
    let names: Vec<String> = list_backups(&backups).into_iter().map(|b| b.name).collect();
    assert_eq!(names.iter().filter(|n| n.starts_with("nexus-auto-")).count(), 3);
    assert_eq!(names.iter().filter(|n| n.starts_with("nexus-recent-")).count(), 4);
    assert!(names.contains(&"nexus-manual-keep.db".to_string()), "backups NEXUS did not rotate are never removed");
    // every backup holds the full data
    for b in list_backups(&backups) {
        assert!(b.valid, "{}", b.name);
        assert_eq!((b.tasks, b.events), (Some(2), Some(2)), "{}", b.name);
    }
}
