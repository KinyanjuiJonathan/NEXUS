//! Preparing a screenshot for text recognition, and combining what several
//! passes found.
//!
//! Text on a screen is small, often light grey on white (hints, placeholder
//! text, disabled fields), sometimes light on dark, and links are underlined
//! right through the letters. A recogniser reads all of that poorly as it is.
//! So the picture is turned into clean black-on-white first:
//!
//! * every pixel is measured against the background around it, so grey text on
//!   a white field and white text on a dark page both become dark on light;
//! * thin horizontal rules (underlines, field borders) are taken out;
//! * the picture is enlarged smoothly, because small letters are read badly.
//!
//! A second, stronger picture is made for faint text. It is read separately
//! and only the lines the first reading missed are taken from it.
//!
//! Nothing here depends on Windows, so it is tested like the rest of the core.

/// One recognised line and its box, in pixels of the picture that was captured.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct Line {
    pub text: String,
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

/// Side of the squares the background is measured in.
const BLOCK: usize = 16;

/// Brightness (0–255) of each pixel of a BGRA picture.
pub fn luminance(bgra: &[u8], w: usize, h: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(w * h);
    for px in bgra.chunks_exact(4).take(w * h) {
        // integer Rec. 601 weights
        out.push(((px[2] as u32 * 299 + px[1] as u32 * 587 + px[0] as u32 * 114) / 1000) as u8);
    }
    out.resize(w * h, 255);
    out
}

/// True when the picture is mostly dark (light text on a dark page).
pub fn is_dark(lum: &[u8]) -> bool {
    if lum.is_empty() {
        return false;
    }
    // the median, from a sample: the background is what most of the picture is
    let mut hist = [0u32; 256];
    let step = (lum.len() / 20_000).max(1);
    let mut n = 0u32;
    for v in lum.iter().step_by(step) {
        hist[*v as usize] += 1;
        n += 1;
    }
    let mut seen = 0u32;
    for (v, count) in hist.iter().enumerate() {
        seen += count;
        if seen * 2 >= n {
            return v < 110;
        }
    }
    false
}

/// The background brightness around each pixel: the brightest value in its
/// square (text is thin, so it rarely fills one), or in the squares around it
/// when its own is nearly all ink.
fn background(lum: &[u8], w: usize, h: usize) -> (Vec<u8>, usize, usize) {
    let bw = w.div_ceil(BLOCK).max(1);
    let bh = h.div_ceil(BLOCK).max(1);
    let mut top = vec![0u8; bw * bh];
    for y in 0..h {
        let row = &lum[y * w..(y + 1) * w];
        let by = y / BLOCK;
        for (x, v) in row.iter().enumerate() {
            let slot = &mut top[by * bw + x / BLOCK];
            if *v > *slot {
                *slot = *v;
            }
        }
    }
    let mut out = vec![0u8; bw * bh];
    for by in 0..bh {
        for bx in 0..bw {
            let mut best = 0u8;
            for ny in by.saturating_sub(1)..(by + 2).min(bh) {
                for nx in bx.saturating_sub(1)..(bx + 2).min(bw) {
                    best = best.max(top[ny * bw + nx]);
                }
            }
            // A square's own brightest pixel is its background (a grey field on a white page keeps its grey),
            // unless the square is nearly all ink (large bold letters): then the surroundings decide.
            let own = top[by * bw + bx];
            out[by * bw + bx] = if own as u32 * 10 >= best as u32 * 6 { own } else { best };
        }
    }
    (out, bw, bh)
}

/// How strongly text is darkened.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Strength {
    /// For ordinary text: contrast is evened out, light greys stay lighter than black.
    Normal,
    /// For faint text: anything a little darker than its background becomes clearly dark.
    Faint,
}

/// Dark text on a white background, whatever the picture looked like.
/// `lum` is `luminance`; the result has the same size.
pub fn clean(lum: &[u8], w: usize, h: usize, strength: Strength) -> Vec<u8> {
    let dark = is_dark(lum);
    let src: Vec<u8> = if dark { lum.iter().map(|v| 255 - v).collect() } else { lum.to_vec() };
    let (bg, bw, _) = background(&src, w, h);
    // ratio to the background at which a pixel counts as plain background, and the curve below it
    let (white, power) = match strength {
        Strength::Normal => (0.90_f32, 1.0_f32),
        Strength::Faint => (0.95_f32, 2.6_f32),
    };
    let mut out = vec![255u8; w * h];
    for y in 0..h {
        for x in 0..w {
            let b = bg[(y / BLOCK) * bw + x / BLOCK].max(1) as f32;
            let ratio = (src[y * w + x] as f32 / b).min(1.0);
            if ratio >= white {
                continue;
            }
            // 0 = as dark as it gets, 1 = background
            let level = (ratio / white).powf(power);
            out[y * w + x] = (level * 255.0) as u8;
        }
    }
    out
}

/// Take out thin horizontal rules: underlines under links and the borders of
/// fields. A rule is a long unbroken run of ink in one row that is not part of
/// a filled shape. Letters are short runs, so they are left alone (a descender
/// loses a pixel or two where it crosses an underline).
pub fn remove_rules(img: &mut [u8], w: usize, h: usize) {
    // anything clearly darker than the white background: rules are often thin and blended to a light grey
    const INK: u8 = 215;
    let min_run = 28.min(w);
    let mut erase: Vec<(usize, usize, usize)> = Vec::new();
    for y in 0..h {
        let mut x = 0;
        while x < w {
            if img[y * w + x] >= INK {
                x += 1;
                continue;
            }
            let start = x;
            while x < w && img[y * w + x] < INK {
                x += 1;
            }
            let len = x - start;
            if len < min_run {
                continue;
            }
            // A run this long in one row is not part of a letter. It is a rule unless it is the inside or the
            // edge of a filled shape (a button, an icon): there the rows above or below are solid along it too.
            // Letters sitting on an underline cover only part of the row above it, so they do not count as solid.
            let solid = |row: Option<usize>| match row {
                Some(r) if r < h => img[r * w + start..r * w + x].iter().filter(|v| **v < INK).count() * 10 >= len * 7,
                _ => false,
            };
            if !solid(y.checked_sub(3)) && !solid(Some(y + 3)) {
                erase.push((y, start, x));
            }
        }
    }
    for (y, a, b) in erase {
        for v in &mut img[y * w + a..y * w + b] {
            *v = 255;
        }
    }
}

/// The largest whole enlargement (1–3) that keeps both sides within `max_side`
/// and the picture within a sensible number of pixels.
pub fn scale_for(w: usize, h: usize, max_side: usize) -> usize {
    for s in [3usize, 2] {
        if w * s <= max_side && h * s <= max_side && w * s * h * s <= 24_000_000 {
            return s;
        }
    }
    1
}

/// Enlarge a grey picture `s` times with smooth (bilinear) blending and return it as opaque BGRA.
pub fn enlarge_bgra(img: &[u8], w: usize, h: usize, s: usize) -> Vec<u8> {
    let (ow, oh) = (w * s, h * s);
    let mut out = vec![255u8; ow * oh * 4];
    if w == 0 || h == 0 {
        return out;
    }
    for oy in 0..oh {
        // centre of the output pixel, in source coordinates
        let fy = ((oy as f32 + 0.5) / s as f32 - 0.5).clamp(0.0, (h - 1) as f32);
        let y0 = fy as usize;
        let y1 = (y0 + 1).min(h - 1);
        let ty = fy - y0 as f32;
        for ox in 0..ow {
            let fx = ((ox as f32 + 0.5) / s as f32 - 0.5).clamp(0.0, (w - 1) as f32);
            let x0 = fx as usize;
            let x1 = (x0 + 1).min(w - 1);
            let tx = fx - x0 as f32;
            let top = img[y0 * w + x0] as f32 * (1.0 - tx) + img[y0 * w + x1] as f32 * tx;
            let bottom = img[y1 * w + x0] as f32 * (1.0 - tx) + img[y1 * w + x1] as f32 * tx;
            let v = (top * (1.0 - ty) + bottom * ty).round() as u8;
            let at = (oy * ow + ox) * 4;
            out[at] = v;
            out[at + 1] = v;
            out[at + 2] = v;
        }
    }
    out
}

/// A picture ready for the recogniser: BGRA, its width and height, and how much it was enlarged.
pub struct Prepared {
    pub bgra: Vec<u8>,
    pub w: usize,
    pub h: usize,
    pub scale: usize,
}

/// Everything above in one step.
pub fn prepare(bgra: &[u8], w: usize, h: usize, max_side: usize, strength: Strength) -> Prepared {
    let lum = luminance(bgra, w, h);
    let mut img = clean(&lum, w, h, strength);
    remove_rules(&mut img, w, h);
    let scale = scale_for(w, h, max_side);
    Prepared { bgra: enlarge_bgra(&img, w, h, scale), w: w * scale, h: h * scale, scale }
}

fn overlap(a0: f32, a1: f32, b0: f32, b1: f32) -> f32 {
    (a1.min(b1) - a0.max(b0)).max(0.0)
}

/// `extra` lines that the `main` reading does not already cover, added to it.
/// A line is covered when a main line sits on the same row and overlaps it sideways.
pub fn merge(main: Vec<Line>, extra: Vec<Line>) -> Vec<Line> {
    let mut out = main;
    let known = out.len();
    for e in extra {
        if e.text.trim().chars().filter(|c| c.is_alphanumeric()).count() == 0 {
            continue; // specks read as punctuation
        }
        let covered = out[..known].iter().any(|m| {
            let rows = overlap(m.y, m.y + m.h, e.y, e.y + e.h);
            let cols = overlap(m.x, m.x + m.w, e.x, e.x + e.w);
            rows > 0.4 * e.h.min(m.h).max(1.0) && cols > 0.2 * e.w.min(m.w).max(1.0)
        });
        if !covered {
            out.push(e);
        }
    }
    out.sort_by(|a, b| a.y.partial_cmp(&b.y).unwrap_or(std::cmp::Ordering::Equal).then(a.x.partial_cmp(&b.x).unwrap_or(std::cmp::Ordering::Equal)));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A grey picture as BGRA.
    fn bgra(grey: &[u8]) -> Vec<u8> {
        grey.iter().flat_map(|v| [*v, *v, *v, 255]).collect()
    }

    /// `w`×`h` of `bg` with a block of `ink` drawn in it.
    fn page(w: usize, h: usize, bg: u8, marks: &[(usize, usize, usize, usize, u8)]) -> Vec<u8> {
        let mut img = vec![bg; w * h];
        for (x, y, mw, mh, ink) in marks {
            for yy in *y..(*y + *mh).min(h) {
                for xx in *x..(*x + *mw).min(w) {
                    img[yy * w + xx] = *ink;
                }
            }
        }
        img
    }

    #[test]
    fn grey_text_on_white_becomes_clearly_dark_in_the_faint_pass() {
        // placeholder grey (#b4) letters, 3 px wide, on white
        let img = page(64, 32, 255, &[(10, 10, 3, 10, 180), (20, 10, 3, 10, 180)]);
        let lum = luminance(&bgra(&img), 64, 32);
        let normal = clean(&lum, 64, 32, Strength::Normal);
        let faint = clean(&lum, 64, 32, Strength::Faint);
        assert!(normal[12 * 64 + 11] > 150, "the normal pass leaves it light: {}", normal[12 * 64 + 11]);
        assert!(faint[12 * 64 + 11] < 120, "the faint pass darkens it: {}", faint[12 * 64 + 11]);
        // the background stays white in both
        assert_eq!(normal[2 * 64 + 2], 255);
        assert_eq!(faint[2 * 64 + 2], 255);
    }

    #[test]
    fn light_text_on_a_dark_page_is_turned_into_dark_on_light() {
        let img = page(64, 32, 20, &[(10, 10, 3, 10, 235)]);
        let lum = luminance(&bgra(&img), 64, 32);
        assert!(is_dark(&lum));
        let out = clean(&lum, 64, 32, Strength::Normal);
        assert!(out[12 * 64 + 11] < 60, "the letter is dark: {}", out[12 * 64 + 11]);
        assert_eq!(out[2 * 64 + 2], 255, "the page is white");
    }

    #[test]
    fn a_field_that_is_darker_than_the_page_still_reads_as_background() {
        // a grey input field (#e8) on a white page, with black text in it
        let img = page(96, 48, 255, &[(8, 8, 80, 32, 232), (20, 18, 3, 10, 0)]);
        let lum = luminance(&bgra(&img), 96, 48);
        let out = clean(&lum, 96, 48, Strength::Faint);
        // well inside the field, away from its edge: plain background
        assert_eq!(out[30 * 96 + 60], 255);
        assert!(out[20 * 96 + 21] < 30);
    }

    #[test]
    fn underlines_and_borders_go_and_letters_stay() {
        // letter stems 3×12 with feet along the baseline, and an underline 60×1 two pixels below them
        let mut img = page(96, 40, 255, &[(20, 10, 3, 12, 0), (10, 24, 60, 1, 0), (40, 10, 3, 12, 0), (18, 21, 9, 1, 0), (38, 21, 9, 1, 0), (52, 21, 9, 1, 0)]);
        remove_rules(&mut img, 96, 40);
        assert!(img[24 * 96 + 30] == 255, "the underline is gone");
        assert!(img[15 * 96 + 21] == 0 && img[15 * 96 + 41] == 0, "the letters are untouched");
        // a filled block (an icon, a button) is not a rule
        let mut solid = page(96, 40, 255, &[(10, 10, 60, 14, 0)]);
        remove_rules(&mut solid, 96, 40);
        assert_eq!(solid[16 * 96 + 30], 0);
    }

    #[test]
    fn enlarging_is_smooth_and_keeps_within_the_limit() {
        assert_eq!(scale_for(800, 500, 10_000), 3);
        assert_eq!(scale_for(3000, 2000, 10_000), 2);
        assert_eq!(scale_for(4000, 4000, 10_000), 1);
        assert_eq!(scale_for(1500, 900, 2600), 1);
        // a hard edge between black and white gets in-between values when enlarged
        let img = page(4, 2, 255, &[(0, 0, 2, 2, 0)]);
        let big = enlarge_bgra(&img, 4, 2, 3);
        assert_eq!(big.len(), 12 * 6 * 4);
        let row: Vec<u8> = (0..12).map(|x| big[(3 * 12 + x) * 4]).collect();
        assert_eq!(row[0], 0);
        assert_eq!(row[11], 255);
        assert!(row.windows(2).all(|p| p[0] <= p[1]), "brightness only rises across the edge: {row:?}");
        assert!(row.iter().any(|v| *v > 0 && *v < 255), "there are in-between values: {row:?}");
        assert!(big.chunks_exact(4).all(|p| p[3] == 255));
    }

    #[test]
    fn the_faint_pass_only_adds_what_the_first_reading_missed() {
        let line = |text: &str, x: f32, y: f32, w: f32| Line { text: text.into(), x, y, w, h: 14.0 };
        let main = vec![line("Primary Language*", 10.0, 100.0, 120.0), line("Interaction Mode*", 10.0, 160.0, 120.0)];
        let extra = vec![
            line("Primary Language", 11.0, 101.0, 118.0), // the same line again
            line("C#", 14.0, 128.0, 16.0),                 // grey placeholder the first reading missed
            line(".", 300.0, 40.0, 3.0),                   // a speck
        ];
        let out = merge(main, extra);
        assert_eq!(out.iter().map(|l| l.text.as_str()).collect::<Vec<_>>(), ["Primary Language*", "C#", "Interaction Mode*"]);
    }
}
