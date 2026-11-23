//! Continuous dictation through Windows.Media.SpeechRecognition.
//!
//! One recogniser stays open for the whole session and hands over every phrase
//! as it is finished, so nothing said between phrases is lost (listening one
//! utterance at a time and starting again in between drops whatever is said
//! while the recogniser restarts). Windows ends a session by itself after a
//! long silence; it is simply started again until the caller asks to stop.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use windows::core::HSTRING;
use windows::Foundation::{TimeSpan, TypedEventHandler};
use windows::Globalization::Language;
use windows::Media::SpeechRecognition::{
    SpeechContinuousRecognitionCompletedEventArgs, SpeechContinuousRecognitionResultGeneratedEventArgs, SpeechContinuousRecognitionSession,
    SpeechRecognitionConfidence, SpeechRecognitionHypothesisGeneratedEventArgs, SpeechRecognitionResultStatus, SpeechRecognitionScenario,
    SpeechRecognitionTopicConstraint, SpeechRecognizer,
};
use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};

/// What the recogniser reports while dictating.
pub enum Heard {
    /// Words recognised so far in the phrase being spoken (it may still change).
    Partial(String),
    /// A finished phrase. `sure` is false when Windows was not confident about it.
    Phrase { text: String, sure: bool },
}

fn explain(e: windows::core::Error) -> String {
    let code = e.code().0 as u32;
    if code == 0x80045509 {
        "Windows speech privacy policy was not accepted. Turn on 'Online speech recognition' in Windows Settings → Privacy & security → Speech.".into()
    } else {
        format!("Speech recognition is unavailable ({}).", e.message())
    }
}

fn seconds(s: i64) -> TimeSpan {
    TimeSpan { Duration: s * 10_000_000 }
}

/// Listen until `stop` is set, calling `on` for every partial and finished phrase.
/// Blocks the calling thread for the whole session.
pub fn run(language: Option<String>, stop: Arc<AtomicBool>, on: Arc<dyn Fn(Heard) + Send + Sync>) -> Result<(), String> {
    // SAFETY: initialising the WinRT apartment for this worker thread; "already initialised" is fine.
    unsafe {
        let _ = RoInitialize(RO_INIT_MULTITHREADED);
    }
    let recognizer = match language.filter(|l| !l.is_empty()) {
        Some(tag) => {
            let lang = Language::CreateLanguage(&HSTRING::from(tag)).map_err(explain)?;
            SpeechRecognizer::Create(&lang).map_err(explain)?
        }
        None => SpeechRecognizer::new().map_err(explain)?,
    };
    // free dictation, the model meant for sentences rather than short commands
    let topic = SpeechRecognitionTopicConstraint::Create(SpeechRecognitionScenario::Dictation, &HSTRING::from("dictation")).map_err(explain)?;
    recognizer.Constraints().map_err(explain)?.Append(&topic).map_err(explain)?;
    let compiled = recognizer.CompileConstraintsAsync().map_err(explain)?.get().map_err(explain)?;
    if compiled.Status().map_err(explain)? != SpeechRecognitionResultStatus::Success {
        return Err("No speech language pack is installed for this language. Add one in Windows Settings → Time & language → Speech.".into());
    }
    if let Ok(t) = recognizer.Timeouts() {
        // a natural pause ends a phrase; a breath in the middle of a sentence does not
        let _ = t.SetEndSilenceTimeout(TimeSpan { Duration: 6_000_000 });
        let _ = t.SetBabbleTimeout(seconds(0));
    }

    let partial = Arc::clone(&on);
    recognizer
        .HypothesisGenerated(&TypedEventHandler::<SpeechRecognizer, SpeechRecognitionHypothesisGeneratedEventArgs>::new(move |_, args| {
            if let Some(args) = args.as_ref() {
                let text = args.Hypothesis()?.Text()?.to_string();
                if !text.trim().is_empty() {
                    partial(Heard::Partial(text));
                }
            }
            Ok(())
        }))
        .map_err(explain)?;

    let session = recognizer.ContinuousRecognitionSession().map_err(explain)?;
    // Windows stops a silent session by itself; make that rare, and restart below when it happens
    let _ = session.SetAutoStopSilenceTimeout(seconds(120));

    let phrase = Arc::clone(&on);
    session
        .ResultGenerated(&TypedEventHandler::<SpeechContinuousRecognitionSession, SpeechContinuousRecognitionResultGeneratedEventArgs>::new(move |_, args| {
            if let Some(args) = args.as_ref() {
                let result = args.Result()?;
                let text = result.Text()?.to_string();
                let confidence = result.Confidence()?;
                // "Rejected" is noise the recogniser itself does not believe; everything else is kept
                if !text.trim().is_empty() && confidence != SpeechRecognitionConfidence::Rejected {
                    phrase(Heard::Phrase { text, sure: confidence != SpeechRecognitionConfidence::Low });
                }
            }
            Ok(())
        }))
        .map_err(explain)?;

    let ended = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&ended);
    session
        .Completed(&TypedEventHandler::<SpeechContinuousRecognitionSession, SpeechContinuousRecognitionCompletedEventArgs>::new(move |_, _| {
            flag.store(true, Ordering::SeqCst);
            Ok(())
        }))
        .map_err(explain)?;

    session.StartAsync().map_err(explain)?.get().map_err(explain)?;
    let mut restarts = 0u32;
    while !stop.load(Ordering::SeqCst) {
        std::thread::sleep(Duration::from_millis(80));
        if ended.swap(false, Ordering::SeqCst) && !stop.load(Ordering::SeqCst) {
            // the session ended by itself (a long silence, or the microphone changed): carry on listening
            restarts += 1;
            if let Err(e) = session.StartAsync().and_then(|op| op.get()) {
                if restarts > 3 {
                    return Err(explain(e));
                }
                std::thread::sleep(Duration::from_millis(400));
                ended.store(true, Ordering::SeqCst);
            } else {
                restarts = 0;
            }
        }
    }
    // let the phrase being spoken finish before closing
    let _ = session.StopAsync().and_then(|op| op.get());
    Ok(())
}
