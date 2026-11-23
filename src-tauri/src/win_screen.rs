//! Reading text off a part of the screen: a GDI screenshot of the region,
//! handed to the text recognition that ships with Windows (Windows.Media.Ocr).
//! Everything happens on this PC; no image or text leaves it.

use windows::Graphics::Imaging::{BitmapAlphaMode, BitmapPixelFormat, SoftwareBitmap};
use windows::Media::Ocr::OcrEngine;
use windows::Storage::Streams::{DataWriter, IBuffer};
use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits, ReleaseDC, SelectObject, BITMAPINFO,
    BITMAPINFOHEADER, BI_RGB, CAPTUREBLT, DIB_RGB_COLORS, SRCCOPY,
};
use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};

/// The largest region read in one go (pixels on a side).
pub const MAX_SIDE: i32 = 4000;

/// BGRA pixels of a screen rectangle, top row first. Coordinates are physical pixels of the virtual desktop.
pub fn capture(x: i32, y: i32, w: i32, h: i32) -> Result<Vec<u8>, String> {
    if w < 8 || h < 8 || w > MAX_SIDE || h > MAX_SIDE {
        return Err("That region is too small or too large to read.".into());
    }
    // SAFETY: plain GDI calls on handles created and released within this function.
    unsafe {
        let screen = GetDC(HWND::default());
        if screen.is_invalid() {
            return Err("The screen could not be read.".into());
        }
        let mem = CreateCompatibleDC(screen);
        let bitmap = CreateCompatibleBitmap(screen, w, h);
        let old = SelectObject(mem, bitmap);
        let copied = BitBlt(mem, 0, 0, w, h, screen, x, y, SRCCOPY | CAPTUREBLT);
        let mut pixels = vec![0u8; (w as usize) * (h as usize) * 4];
        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -h, // negative: top row first
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let rows = GetDIBits(mem, bitmap, 0, h as u32, Some(pixels.as_mut_ptr().cast()), &mut info, DIB_RGB_COLORS);
        SelectObject(mem, old);
        let _ = DeleteObject(bitmap);
        let _ = DeleteDC(mem);
        ReleaseDC(HWND::default(), screen);
        if copied.is_err() || rows == 0 {
            return Err("The screen could not be copied (a protected window may be in the way).".into());
        }
        // GDI leaves the alpha byte at zero; the recogniser wants opaque pixels
        for px in pixels.chunks_exact_mut(4) {
            px[3] = 255;
        }
        Ok(pixels)
    }
}

/// Double the image (each pixel becomes a 2×2 square): small on-screen text is recognised far more reliably.
fn doubled(pixels: &[u8], w: usize, h: usize) -> Vec<u8> {
    let mut out = vec![0u8; w * h * 16];
    for row in 0..h {
        for col in 0..w {
            let src = (row * w + col) * 4;
            for (dr, dc) in [(0, 0), (0, 1), (1, 0), (1, 1)] {
                let dst = ((row * 2 + dr) * w * 2 + col * 2 + dc) * 4;
                out[dst..dst + 4].copy_from_slice(&pixels[src..src + 4]);
            }
        }
    }
    out
}

/// The text in a BGRA image, one string per recognised line, top to bottom.
pub fn recognise(pixels: &[u8], w: i32, h: i32) -> Result<Vec<String>, String> {
    let fail = |e: windows::core::Error| format!("Text recognition is unavailable ({}). Add a language with text recognition in Windows Settings → Time & language.", e.message());
    // SAFETY: initialising the WinRT apartment for this worker thread; "already initialised" is fine.
    unsafe {
        let _ = RoInitialize(RO_INIT_MULTITHREADED);
    }
    let engine = OcrEngine::TryCreateFromUserProfileLanguages().map_err(fail)?;
    let max = OcrEngine::MaxImageDimension().unwrap_or(2600) as i32;
    // enlarge unless that would exceed what the recogniser accepts
    let (data, w, h) = if w * 2 <= max && h * 2 <= max { (doubled(pixels, w as usize, h as usize), w * 2, h * 2) } else { (pixels.to_vec(), w, h) };
    if w > max || h > max {
        return Err("That region is too large for text recognition. Select a smaller part of the screen.".into());
    }
    let writer = DataWriter::new().map_err(fail)?;
    writer.WriteBytes(&data).map_err(fail)?;
    let buffer: IBuffer = writer.DetachBuffer().map_err(fail)?;
    let bitmap = SoftwareBitmap::CreateCopyWithAlphaFromBuffer(&buffer, BitmapPixelFormat::Bgra8, w, h, BitmapAlphaMode::Premultiplied).map_err(fail)?;
    let result = engine.RecognizeAsync(&bitmap).map_err(fail)?.get().map_err(fail)?;
    let mut lines = Vec::new();
    for line in result.Lines().map_err(fail)? {
        let text = line.Text().map_err(fail)?.to_string();
        if !text.trim().is_empty() {
            lines.push(text);
        }
    }
    Ok(lines)
}

/// Capture a screen rectangle and read the text in it.
pub fn read_region(x: i32, y: i32, w: i32, h: i32) -> Result<Vec<String>, String> {
    let pixels = capture(x, y, w, h)?;
    recognise(&pixels, w, h)
}
