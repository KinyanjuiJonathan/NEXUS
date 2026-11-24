//! Windows Hello: ask Windows to confirm that the person at the keyboard is the
//! signed-in user, with their fingerprint, face or PIN. NEXUS never sees the
//! fingerprint; Windows only answers "verified" or not.

use windows::core::{factory, HSTRING};
use windows::Foundation::IAsyncOperation;
use windows::Security::Credentials::UI::{UserConsentVerificationResult, UserConsentVerifier, UserConsentVerifierAvailability};
use windows::Win32::Foundation::HWND;
use windows::Win32::System::WinRT::{IUserConsentVerifierInterop, RoInitialize, RO_INIT_MULTITHREADED};

/// Whether Windows Hello is set up on this PC.
pub fn available() -> bool {
    // SAFETY: initialising the WinRT apartment for this thread; "already initialised" is fine.
    unsafe {
        let _ = RoInitialize(RO_INIT_MULTITHREADED);
    }
    UserConsentVerifier::CheckAvailabilityAsync()
        .and_then(|op| op.get())
        .map(|a| a == UserConsentVerifierAvailability::Available)
        .unwrap_or(false)
}

/// Show the Windows Hello prompt over the given window. Ok(true) when the user was verified.
pub fn verify(hwnd: isize, message: &str) -> Result<bool, String> {
    // SAFETY: as above.
    unsafe {
        let _ = RoInitialize(RO_INIT_MULTITHREADED);
    }
    let fail = |e: windows::core::Error| format!("Windows Hello is unavailable ({}).", e.message());
    // A desktop app has to say which window the prompt belongs to.
    let interop = factory::<UserConsentVerifier, IUserConsentVerifierInterop>().map_err(fail)?;
    // SAFETY: `hwnd` is the handle of a live window of this process, passed by the caller.
    let operation: IAsyncOperation<UserConsentVerificationResult> =
        unsafe { interop.RequestVerificationForWindowAsync(HWND(hwnd as *mut core::ffi::c_void), &HSTRING::from(message)) }.map_err(fail)?;
    let result = operation.get().map_err(fail)?;
    Ok(result == UserConsentVerificationResult::Verified)
}
