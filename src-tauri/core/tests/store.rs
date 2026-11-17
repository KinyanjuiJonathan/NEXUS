use nexus_core::*;
use serde_json::json;

fn task(id: &str, title: &str) -> Task {
    Task {
        id: id.into(),
        title: title.into(),
        notes: String::new(),
        priority: "high".into(),
        category_id: "work".into(),
        status: "todo".into(),
        due_at: Some(1_800_000_000_000),
        due_tz: Some("Africa/Nairobi".into()),
        estimate_min: Some(45),
        spent_ms: 0,
        sort_order: 0.0,
        recurrence: None,
        reminders: vec![0, 15],
        subtasks: vec![
            Subtask { id: format!("{id}-s1"), title: "Outline".into(), done: true },
            Subtask { id: format!("{id}-s2"), title: "Draft".into(), done: false },
        ],
        completed_at: None,
        archived_at: None,
        deleted_at: None,
        created_at: 1,
        updated_at: 1,
    }
}

fn event(id: &str) -> CalendarEvent {
    CalendarEvent {
        id: id.into(),
        title: "Client sync".into(),
        notes: String::new(),
        start_at: 1_800_000_000_000,
        end_at: 1_800_003_600_000,
        tz: "America/Chicago".into(),
        task_id: None,
        recurrence: Some(json!({"freq":"weekly","interval":1})),
        important: true,
        reminders: vec![15],
        color: None,
        created_at: 1,
        updated_at: 1,
        deleted_at: None,
    }
}

#[test]
fn migrations_create_schema_and_builtin_categories() {
    let s = Store::open_in_memory().unwrap();
    assert_eq!(s.schema_version().unwrap(), migrations::LATEST);
    let cats: Vec<String> = s.list_categories().unwrap().into_iter().map(|c| c.id).collect();
    assert_eq!(cats, vec!["work", "personal", "projects", "meetings"]);
}

#[test]
fn task_create_edit_delete_roundtrip() {
    let mut s = Store::open_in_memory().unwrap();
    let mut t = task("a", "Finish report");
    s.upsert_task(&t).unwrap();
    assert_eq!(s.get_task("a").unwrap().unwrap(), t);

    // edit: title, subtasks, recurrence
    t.title = "Finish quarterly report".into();
    t.subtasks.pop();
    t.recurrence = Some(json!({"freq":"daily","interval":1}));
    t.updated_at = 2;
    s.upsert_task(&t).unwrap();
    let got = s.get_task("a").unwrap().unwrap();
    assert_eq!(got.title, "Finish quarterly report");
    assert_eq!(got.subtasks.len(), 1);
    assert_eq!(got.recurrence, Some(json!({"freq":"daily","interval":1})));

    // soft delete (trash) then restore
    t.deleted_at = Some(5);
    s.upsert_task(&t).unwrap();
    assert_eq!(s.get_task("a").unwrap().unwrap().deleted_at, Some(5));
    t.deleted_at = None;
    s.upsert_task(&t).unwrap();
    assert_eq!(s.get_task("a").unwrap().unwrap().deleted_at, None);

    // hard delete cascades subtasks
    s.delete_task("a").unwrap();
    assert!(s.get_task("a").unwrap().is_none());
    assert!(s.list_tasks().unwrap().is_empty());
}

#[test]
fn rejects_invalid_data() {
    let mut s = Store::open_in_memory().unwrap();
    let mut t = task("a", "  ");
    assert!(s.upsert_task(&t).is_err());
    t.title = "ok".into();
    t.priority = "whenever".into();
    assert!(s.upsert_task(&t).is_err());
    let mut e = event("e");
    e.end_at = e.start_at - 1;
    assert!(s.upsert_event(&e).is_err());
}

#[test]
fn reorder_persists() {
    let mut s = Store::open_in_memory().unwrap();
    for id in ["a", "b", "c"] {
        s.upsert_task(&task(id, id)).unwrap();
    }
    s.reorder_tasks(&["c".into(), "a".into(), "b".into()]).unwrap();
    let ids: Vec<String> = s.list_tasks().unwrap().into_iter().map(|t| t.id).collect();
    assert_eq!(ids, vec!["c", "a", "b"]);
}

#[test]
fn data_survives_reopen_from_disk() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("nexus.db");
    {
        let mut s = Store::open(&path).unwrap();
        s.upsert_task(&task("a", "Persist me")).unwrap();
        s.upsert_event(&event("e")).unwrap();
        s.set_setting("hour12", &json!(true)).unwrap();
        s.set_setting("overlayGeometry", &json!({"x": 1600, "y": 40, "w": 340, "h": 220})).unwrap();
    }
    let s = Store::open(&path).unwrap();
    let snap = s.load_snapshot().unwrap();
    assert_eq!(snap.tasks[0].title, "Persist me");
    assert_eq!(snap.tasks[0].subtasks.len(), 2);
    assert_eq!(snap.events[0].tz, "America/Chicago");
    assert_eq!(snap.events[0].recurrence, Some(json!({"freq":"weekly","interval":1})));
    assert_eq!(snap.settings["hour12"], json!(true));
    assert_eq!(snap.settings["overlayGeometry"]["x"], json!(1600));
}

#[test]
fn reminders_sync_due_snooze_dismiss() {
    let mut s = Store::open_in_memory().unwrap();
    let plan = |at: i64| PlannedReminder { fire_at: at, title: "Due".into(), body: String::new() };
    s.sync_reminders("task", "a", &[plan(100), plan(200)]).unwrap();
    assert_eq!(s.next_fire_at().unwrap(), Some(100));
    let due = s.due_reminders(150).unwrap();
    assert_eq!(due.len(), 1);
    s.mark_fired(&due[0].id, 150).unwrap();
    assert!(s.due_reminders(150).unwrap().is_empty());

    // Re-sync replaces only pending reminders; fired history is kept
    s.sync_reminders("task", "a", &[plan(300)]).unwrap();
    assert_eq!(s.upcoming_reminders(0, 10).unwrap().len(), 1);

    // Snooze a fired reminder: it becomes pending again later
    let snoozed = s.snooze_reminder(&due[0].id, 5, 1_000).unwrap().unwrap();
    assert_eq!(snoozed.fire_at, 1_000 + 5 * 60_000);
    assert!(snoozed.fired_at.is_none());
    // A re-sync must not drop the snoozed one
    s.sync_reminders("task", "a", &[]).unwrap();
    assert_eq!(s.due_reminders(1_000 + 5 * 60_000).unwrap().len(), 1);
    s.dismiss_reminder(&due[0].id, 2_000).unwrap();
    assert!(s.due_reminders(i64::MAX).unwrap().is_empty());
}

#[test]
fn trash_purge_after_30_days() {
    let mut s = Store::open_in_memory().unwrap();
    let mut t = task("old", "Old");
    t.deleted_at = Some(0);
    s.upsert_task(&t).unwrap();
    let mut t2 = task("new", "New");
    t2.deleted_at = Some(31 * 24 * 3600 * 1000);
    s.upsert_task(&t2).unwrap();
    s.purge_expired(32 * 24 * 3600 * 1000).unwrap();
    let ids: Vec<String> = s.list_tasks().unwrap().into_iter().map(|t| t.id).collect();
    assert_eq!(ids, vec!["new"]);
}

#[test]
fn backup_restore_and_json_export_import() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = Store::open(dir.path().join("nexus.db")).unwrap();
    s.upsert_task(&task("a", "Keep")).unwrap();
    let bak = dir.path().join("b.db");
    s.backup_to(&bak).unwrap();

    s.delete_task("a").unwrap();
    s.upsert_task(&task("b", "Later")).unwrap();
    s.restore_from(&bak, dir.path().join("safety.db")).unwrap();
    let ids: Vec<String> = s.list_tasks().unwrap().into_iter().map(|t| t.id).collect();
    assert_eq!(ids, vec!["a"]);
    // the pre-restore state is recoverable
    let safety = Store::open(dir.path().join("safety.db")).unwrap();
    assert_eq!(safety.list_tasks().unwrap()[0].id, "b");

    // invalid file refused, data untouched
    std::fs::write(dir.path().join("junk.db"), b"not sqlite").unwrap();
    assert!(s.restore_from(dir.path().join("junk.db"), dir.path().join("s2.db")).is_err());
    assert_eq!(s.list_tasks().unwrap().len(), 1);

    // JSON export → import into a fresh store
    s.upsert_event(&event("e")).unwrap();
    s.set_setting("theme", &json!("light")).unwrap();
    let bundle = s.export_bundle().unwrap();
    let text = serde_json::to_string(&bundle).unwrap();
    let mut fresh = Store::open_in_memory().unwrap();
    fresh.upsert_task(&task("zzz", "will be replaced")).unwrap();
    fresh.import_bundle(&serde_json::from_str(&text).unwrap()).unwrap();
    let snap = fresh.load_snapshot().unwrap();
    assert_eq!(snap.tasks.len(), 1);
    assert_eq!(snap.tasks[0].id, "a");
    assert_eq!(snap.events.len(), 1);
    assert_eq!(snap.settings["theme"], json!("light"));
}

#[test]
fn migration_from_older_schema_takes_a_backup_first() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("nexus.db");
    {
        // Simulate a v1 database created by an older NEXUS
        let mut conn = rusqlite::Connection::open(&path).unwrap();
        let tx = conn.transaction().unwrap();
        tx.execute_batch(migrations::MIGRATIONS[0]).unwrap();
        tx.pragma_update(None, "user_version", 1).unwrap();
        tx.commit().unwrap();
    }
    let s = Store::open(&path).unwrap();
    assert_eq!(s.schema_version().unwrap(), migrations::LATEST);
    let backups: Vec<_> = std::fs::read_dir(dir.path().join("backups")).unwrap().collect();
    assert_eq!(backups.len(), 1);
}

#[test]
fn refuses_newer_schema() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("nexus.db");
    {
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.pragma_update(None, "user_version", 999).unwrap();
    }
    assert!(matches!(Store::open(&path), Err(Error::NewerSchema { .. })));
}

#[test]
fn auto_backup_rotates() {
    let dir = tempfile::tempdir().unwrap();
    let s = Store::open(dir.path().join("nexus.db")).unwrap();
    let bdir = dir.path().join("backups");
    let day = 24 * 3600 * 1000;
    for i in 0..5 {
        assert!(s.auto_backup(&bdir, 3, 1_800_000_000_000 + i * day).unwrap().is_some());
    }
    // second call the same day is a no-op
    assert!(s.auto_backup(&bdir, 3, 1_800_000_000_000 + 4 * day + 1000).unwrap().is_none());
    assert_eq!(std::fs::read_dir(&bdir).unwrap().count(), 3);
}

#[test]
fn categories_and_focus_sessions() {
    let mut s = Store::open_in_memory().unwrap();
    let c = Category { id: "health".into(), name: "Health".into(), color: "#22c55e".into(), icon: "heart".into(), builtin: false, sort_order: 9.0 };
    s.upsert_category(&c).unwrap();
    let mut t = task("a", "Run");
    t.category_id = "health".into();
    s.upsert_task(&t).unwrap();
    assert!(s.delete_category("work", "personal").is_err());
    s.delete_category("health", "personal").unwrap();
    assert_eq!(s.get_task("a").unwrap().unwrap().category_id, "personal");

    s.add_focus_session(&FocusSession { id: "f".into(), task_id: Some("a".into()), kind: "pomodoro".into(), started_at: 10, ended_at: 20, duration_ms: 10 }).unwrap();
    assert_eq!(s.list_focus_sessions(0).unwrap().len(), 1);
    assert!(s.add_focus_session(&FocusSession { id: "g".into(), task_id: None, kind: "pomodoro".into(), started_at: 20, ended_at: 10, duration_ms: 0 }).is_err());
}

#[test]
fn work_sessions_and_activity_history() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("nexus.db");
    {
        let s = Store::open(&path).unwrap();
        let w = WorkSession {
            id: "w1".into(),
            started_at: 1_000,
            ended_at: None,
            pauses: json!([{ "start": 2_000, "end": 3_000, "reason": "idle" }]),
            note: String::new(),
            created_at: 1_000,
            updated_at: 1_000,
        };
        s.upsert_work_session(&w).unwrap();
        s.add_activity(&ActivityEntry { id: "a1".into(), at: 5, kind: "clock_in".into(), title: "Clocked in".into(), detail: String::new(), ref_id: Some("w1".into()) }).unwrap();
        s.add_activity(&ActivityEntry { id: "a2".into(), at: 9, kind: "task_completed".into(), title: "Report".into(), detail: String::new(), ref_id: None }).unwrap();
        assert!(s.add_activity(&ActivityEntry { id: "bad".into(), at: 1, kind: "x".into(), title: " ".into(), detail: String::new(), ref_id: None }).is_err());
        let mut bad = w.clone();
        bad.ended_at = Some(10);
        assert!(s.upsert_work_session(&bad).is_err());
    }
    let s = Store::open(&path).unwrap();
    let ws = s.list_work_sessions(0).unwrap();
    assert_eq!(ws[0].pauses[0]["reason"], json!("idle"));
    // an open session is always returned, however old
    assert_eq!(s.list_work_sessions(i64::MAX).unwrap().len(), 1);
    let ids: Vec<String> = s.list_activity(0, 10).unwrap().into_iter().map(|a| a.id).collect();
    assert_eq!(ids, vec!["a2", "a1"], "history is newest first");
    // round-trips through export/import
    let bundle = s.export_bundle().unwrap();
    let mut fresh = Store::open_in_memory().unwrap();
    fresh.import_bundle(&bundle).unwrap();
    assert_eq!(fresh.list_activity(0, 10).unwrap().len(), 2);
    assert_eq!(fresh.list_work_sessions(0).unwrap().len(), 1);
}

#[test]
fn v3_migration_backfills_history_from_existing_data() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("nexus.db");
    {
        let mut conn = rusqlite::Connection::open(&path).unwrap();
        for (i, sql) in migrations::MIGRATIONS[..2].iter().enumerate() {
            let tx = conn.transaction().unwrap();
            tx.execute_batch(sql).unwrap();
            tx.pragma_update(None, "user_version", i as i64 + 1).unwrap();
            tx.commit().unwrap();
        }
        conn.execute(
            "INSERT INTO tasks (id, title, priority, category_id, status, completed_at, created_at, updated_at) VALUES ('t1','Old report','high','work','done',500,1,1)",
            [],
        )
        .unwrap();
        conn.execute("INSERT INTO focus_sessions (id, task_id, kind, started_at, ended_at, duration_ms) VALUES ('f1','t1','pomodoro',0,1500000,1500000)", []).unwrap();
    }
    let s = Store::open(&path).unwrap();
    let log = s.list_activity(0, 10).unwrap();
    assert_eq!(log.len(), 2);
    assert!(log.iter().any(|a| a.kind == "task_completed" && a.title == "Old report"));
    assert!(log.iter().any(|a| a.kind == "focus" && a.title == "Old report" && a.detail == "25 min"));
}
