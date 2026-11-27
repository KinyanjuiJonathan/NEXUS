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

pub use nexus_core::ocrprep::Line;
use nexus_core::ocrprep::{merge, prepare, split_columns, Strength, Word};

/// One reading of the picture, prepared at the given strength. Boxes are in pixels of the original picture.
fn pass(engine: &OcrEngine, pixels: &[u8], w: usize, h: usize, max: usize, strength: Strength) -> Result<Vec<Line>, String> {
    let fail = |e: windows::core::Error| format!("Text recognition failed ({}).", e.message());
    let p = prepare(pixels, w, h, max, strength);
    if p.w > max || p.h > max {
        return Err("That region is too large for text recognition. Make the region smaller.".into());
    }
    let scale = p.scale as f32;
    let pad = p.pad as f32;
    let writer = DataWriter::new().map_err(fail)?;
    writer.WriteBytes(&p.bgra).map_err(fail)?;
    let buffer: IBuffer = writer.DetachBuffer().map_err(fail)?;
    let bitmap = SoftwareBitmap::CreateCopyWithAlphaFromBuffer(&buffer, BitmapPixelFormat::Bgra8, p.w as i32, p.h as i32, BitmapAlphaMode::Premultiplied).map_err(fail)?;
    let result = engine.RecognizeAsync(&bitmap).map_err(fail)?.get().map_err(fail)?;
    let mut lines = Vec::new();
    for line in result.Lines().map_err(fail)? {
        // every word with its box, back in pixels of the captured region: undo the enlargement, then the white border
        let mut words = Vec::new();
        for word in line.Words().map_err(fail)? {
            let r = word.BoundingRect().map_err(fail)?;
            words.push(Word { text: word.Text().map_err(fail)?.to_string(), x: r.X / scale - pad, y: r.Y / scale - pad, w: r.Width / scale, h: r.Height / scale });
        }
        // one entry per stretch of text: a line that runs across the columns of a table is split at the gaps
        lines.extend(split_columns(&words));
    }
    Ok(lines)
}

/// The text in a BGRA image, one entry per recognised line, top to bottom.
///
/// The picture is read twice: once with faint text (grey hints, placeholder text, disabled fields,
/// coloured links) made as dark as the rest, and once cleaned up more gently. Lines only the second reading finds are added.
pub fn recognise(pixels: &[u8], w: i32, h: i32) -> Result<Vec<Line>, String> {
    let fail = |e: windows::core::Error| format!("Text recognition is unavailable ({}). Add a language with text recognition in Windows Settings → Time & language.", e.message());
    // SAFETY: initialising the WinRT apartment for this worker thread; "already initialised" is fine.
    unsafe {
        let _ = RoInitialize(RO_INIT_MULTITHREADED);
    }
    let engine = OcrEngine::TryCreateFromUserProfileLanguages().map_err(fail)?;
    let max = OcrEngine::MaxImageDimension().unwrap_or(2600) as usize;
    let (w, h) = (w.max(0) as usize, h.max(0) as usize);
    // The strong picture comes first: it makes grey hints, placeholder text and coloured links as dark as body text.
    let main = pass(&engine, pixels, w, h, max, Strength::Faint)?;
    // The gentler picture is a second opinion for anything the strong one lost; if it fails, the first still stands.
    let plain = pass(&engine, pixels, w, h, max, Strength::Normal).unwrap_or_default();
    Ok(merge(main, plain))
}

/// Capture a screen rectangle and read the text in it.
pub fn read_region(x: i32, y: i32, w: i32, h: i32) -> Result<Vec<Line>, String> {
    let pixels = capture(x, y, w, h)?;
    recognise(&pixels, w, h)
}
