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
    for i in 0..(w * h).min(bgra.len() / 4) {
        let (b, g, r) = (bgra[i * 4] as u32, bgra[i * 4 + 1] as u32, bgra[i * 4 + 2] as u32);
        // integer Rec. 601 weights
        out.push(((r * 299 + g * 587 + b * 114) / 1000) as u8);
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

/// Brightness counts of one square of the picture.
fn histogram(img: &[u8], w: usize, x0: usize, x1: usize, y0: usize, y1: usize) -> [u16; 256] {
    let mut hist = [0u16; 256];
    for y in y0..y1 {
        for v in &img[y * w + x0..y * w + x1] {
            hist[*v as usize] += 1;
        }
    }
    hist
}

/// The brightness below which `share` (0–1) of the counted pixels lie.
fn level_at(hist: &[u16; 256], total: usize, share: f32) -> u8 {
    let want = (total as f32 * share) as u32;
    let mut seen = 0u32;
    for (v, count) in hist.iter().enumerate() {
        seen += *count as u32;
        if seen > want {
            return v as u8;
        }
    }
    255
}

/// The ground each square of text sits on: the brightness most of the square has. Text is thin,
/// so three quarters of a square's pixels are ground, whatever its colour; a grey field on a white
/// page keeps its grey, and a coloured band keeps its colour.
fn background(img: &[u8], w: usize, h: usize) -> (Vec<u8>, usize, usize) {
    let bw = w.div_ceil(BLOCK).max(1);
    let bh = h.div_ceil(BLOCK).max(1);
    let mut out = vec![255u8; bw * bh];
    for by in 0..bh {
        for bx in 0..bw {
            let (x0, y0) = (bx * BLOCK, by * BLOCK);
            let (x1, y1) = ((x0 + BLOCK).min(w), (y0 + BLOCK).min(h));
            if x1 <= x0 || y1 <= y0 {
                continue;
            }
            let hist = histogram(img, w, x0, x1, y0, y1);
            out[by * bw + bx] = level_at(&hist, (x1 - x0) * (y1 - y0), 0.75);
        }
    }
    (out, bw, bh)
}

/// Light text on a dark patch of an otherwise light picture (a table's coloured header row,
/// a button) is turned into dark text on a light patch, square by square: where the ground of a
/// square is clearly darker than the page and what is written on it is lighter than the ground.
fn flip_dark_patches(img: &mut [u8], w: usize, h: usize) {
    let mut y0 = 0;
    while y0 < h {
        let y1 = (y0 + BLOCK).min(h);
        let mut x0 = 0;
        while x0 < w {
            let x1 = (x0 + BLOCK).min(w);
            let hist = histogram(img, w, x0, x1, y0, y1);
            let total = (y1 - y0) * (x1 - x0);
            let ground = level_at(&hist, total, 0.5) as i32;
            let lightest = level_at(&hist, total, 0.97) as i32;
            let darkest = level_at(&hist, total, 0.03) as i32;
            if ground < 200 && lightest - ground > 45 && lightest - ground > ground - darkest + 15 {
                for y in y0..y1 {
                    for v in &mut img[y * w + x0..y * w + x1] {
                        *v = 255 - *v;
                    }
                }
            }
            x0 = x1;
        }
        y0 = y1;
    }
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
    let mut src: Vec<u8> = if dark { lum.iter().map(|v| 255 - v).collect() } else { lum.to_vec() };
    flip_dark_patches(&mut src, w, h);
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

/// White space added on every side before reading, in pixels of the captured picture.
/// Recognisers skip or misread text that touches the edge of a picture; with room around it,
/// the first and last lines and anything against the left or right side are read like the rest.
pub const PAD: usize = 14;

/// The picture with a white border of `pad` pixels on every side.
pub fn padded(img: &[u8], w: usize, h: usize, pad: usize) -> (Vec<u8>, usize, usize) {
    let (pw, ph) = (w + 2 * pad, h + 2 * pad);
    let mut out = vec![255u8; pw * ph];
    for y in 0..h {
        out[(y + pad) * pw + pad..(y + pad) * pw + pad + w].copy_from_slice(&img[y * w..(y + 1) * w]);
    }
    (out, pw, ph)
}

/// A picture ready for the recogniser: BGRA, its width and height, how much it was enlarged,
/// and the white border around it (in pixels of the captured picture, before enlarging).
/// A point (x, y) the recogniser reports is at (x / scale - pad, y / scale - pad) in the capture.
pub struct Prepared {
    pub bgra: Vec<u8>,
    pub w: usize,
    pub h: usize,
    pub scale: usize,
    pub pad: usize,
}

/// Everything above in one step.
pub fn prepare(bgra: &[u8], w: usize, h: usize, max_side: usize, strength: Strength) -> Prepared {
    let lum = luminance(bgra, w, h);
    let mut img = clean(&lum, w, h, strength);
    remove_rules(&mut img, w, h);
    let (img, pw, ph) = padded(&img, w, h, PAD);
    let scale = scale_for(pw, ph, max_side);
    Prepared { bgra: enlarge_bgra(&img, pw, ph, scale), w: pw * scale, h: ph * scale, scale, pad: PAD }
}

// ------------------------------------------------------------------ columns

/// One recognised word and its box.
#[derive(Clone, Debug, PartialEq)]
pub struct Word {
    pub text: String,
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

/// The words of one recognised line, as one or more pieces: a recogniser often joins everything
/// on the same height into one line, straight across the columns of a table. Where two words are
/// much further apart than words in a sentence ever are, the line is split there, so each cell's
/// text keeps its own box.
pub fn split_columns(words: &[Word]) -> Vec<Line> {
    let mut sorted: Vec<&Word> = words.iter().filter(|w| !w.text.trim().is_empty()).collect();
    sorted.sort_by(|a, b| a.x.partial_cmp(&b.x).unwrap_or(std::cmp::Ordering::Equal));
    if sorted.is_empty() {
        return Vec::new();
    }
    let height = sorted.iter().map(|w| w.h).fold(0.0_f32, f32::max).max(1.0);
    let chars: usize = sorted.iter().map(|w| w.text.chars().count()).sum();
    let char_w = sorted.iter().map(|w| w.w).sum::<f32>() / chars.max(1) as f32;
    // a space between words is about a third of a letter's height; a column gap is several letters wide
    let limit = (1.5 * height).max(3.0 * char_w);
    let mut out: Vec<Line> = Vec::new();
    let mut piece: Vec<&Word> = Vec::new();
    let close = |piece: &mut Vec<&Word>, out: &mut Vec<Line>| {
        if piece.is_empty() {
            return;
        }
        let x0 = piece.iter().map(|w| w.x).fold(f32::MAX, f32::min);
        let y0 = piece.iter().map(|w| w.y).fold(f32::MAX, f32::min);
        let x1 = piece.iter().map(|w| w.x + w.w).fold(f32::MIN, f32::max);
        let y1 = piece.iter().map(|w| w.y + w.h).fold(f32::MIN, f32::max);
        let text = piece.iter().map(|w| w.text.trim()).collect::<Vec<_>>().join(" ");
        out.push(Line { text, x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
        piece.clear();
    };
    for word in sorted {
        if let Some(last) = piece.last() {
            if word.x - (last.x + last.w) > limit {
                close(&mut piece, &mut out);
            }
        }
        piece.push(word);
    }
    close(&mut piece, &mut out);
    out
}

// ------------------------------------------------------------------ digits read as letters

/// The digit a character is commonly mistaken for ("O" for 0, "I", "l" and "|" for 1), if any.
fn as_digit(c: char) -> Option<char> {
    match c {
        '0'..='9' => Some(c),
        'O' | 'o' => Some('0'),
        'I' | 'l' | '|' => Some('1'),
        _ => None,
    }
}

/// A word split into what surrounds it and its core: "(IO)." → "(", "IO", ").".
fn core_of(word: &str) -> (&str, &str, &str) {
    let start = word.find(|c: char| c.is_alphanumeric() || c == '|').unwrap_or(word.len());
    let end = word.rfind(|c: char| c.is_alphanumeric() || c == '|').map(|i| i + word[i..].chars().next().map_or(0, char::len_utf8)).unwrap_or(start);
    (&word[..start], &word[start..end.max(start)], &word[end.max(start)..])
}

/// Words after which a number is expected: "full at 10", "more than 10", "limit of 10".
const BEFORE_A_NUMBER: [&str; 30] = [
    "at", "to", "of", "is", "than", "by", "from", "over", "under", "about", "around", "exactly", "only", "max", "min", "limit", "top", "first", "last",
    "next", "every", "after", "before", "until", "within", "was", "are", "were", "reaches", "equals",
];

/// Put right the numbers a recogniser reads as letters: "IO" for 10, "2O24" for 2024, "1Oth" for 10th.
///
/// A word is only changed when it can be nothing but a number:
/// * it is made of digits and digit look-alikes and has at least one real digit ("1O", "l0", "2O24", "1Oth");
/// * or it is only look-alikes shaped like 10, 100, 1000 ("IO", "lOO") and follows a word that
///   introduces a number ("at", "than", "of"…). "I/O" and a lone "IO" elsewhere are left alone.
pub fn fix_digits(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut previous = String::new();
    for (i, word) in line.split(' ').enumerate() {
        if i > 0 {
            out.push(' ');
        }
        let (lead, core, tail) = core_of(word);
        // an ordinal keeps its ending: 1Oth
        let lower = core.to_lowercase();
        let (stem, ending) = ["st", "nd", "rd", "th"].iter().find(|e| lower.ends_with(*e) && core.len() > e.len()).map_or((core, ""), |e| core.split_at(core.len() - e.len()));
        let digits: Option<String> = stem.chars().map(as_digit).collect();
        let real = stem.chars().filter(char::is_ascii_digit).count();
        let count = stem.chars().count();
        let fixed = match digits {
            // digits with look-alikes among them
            Some(d) if real >= 1 && real < count && count >= 2 => Some(d),
            // only look-alikes: a one followed by noughts, where a number is expected
            Some(d) if real == 0 && ending.is_empty() && count >= 2 && d.starts_with('1') && d[1..].chars().all(|c| c == '0') && !word.contains('/') && BEFORE_A_NUMBER.contains(&previous.as_str()) => Some(d),
            _ => None,
        };
        match fixed {
            Some(d) => {
                out.push_str(lead);
                out.push_str(&d);
                out.push_str(ending);
                out.push_str(tail);
            }
            None => out.push_str(word),
        }
        previous = lower;
    }
    out
}

/// Two readings of the same line, word by word: where the first has a word of digit look-alikes
/// and the second read the same shape as a number, the number is taken ("IO" and "10" → "10").
pub fn agree_on_digits(main: &str, other: &str) -> String {
    let a: Vec<&str> = main.split_whitespace().collect();
    let b: Vec<&str> = other.split_whitespace().collect();
    if a.len() != b.len() {
        return main.to_string();
    }
    let fold = |w: &str| -> String { w.chars().map(|c| as_digit(c).unwrap_or(c)).collect() };
    let words: Vec<&str> = a
        .iter()
        .zip(&b)
        .map(|(x, y)| {
            // the other reading must be a plain number ("10", "1,000", "10%"), not a word with a stray digit in it
            let number = y.chars().any(|c| c.is_ascii_digit()) && y.chars().all(|c| c.is_ascii_digit() || !c.is_alphanumeric());
            if x != y && number && fold(x) == fold(y) {
                *y
            } else {
                *x
            }
        })
        .collect();
    words.join(" ")
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
        let same = out[..known].iter().position(|m| {
            let rows = overlap(m.y, m.y + m.h, e.y, e.y + e.h);
            let cols = overlap(m.x, m.x + m.w, e.x, e.x + e.w);
            rows > 0.4 * e.h.min(m.h).max(1.0) && cols > 0.2 * e.w.min(m.w).max(1.0)
        });
        match same {
            // the same line read twice: the second reading settles numbers the first read as letters
            Some(i) => out[i].text = agree_on_digits(&out[i].text, &e.text),
            None => out.push(e),
        }
    }
    for line in &mut out {
        line.text = fix_digits(&line.text);
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
        assert!(big.iter().skip(3).step_by(4).all(|alpha| *alpha == 255));
    }

    #[test]
    fn text_against_the_edge_gets_white_space_around_it() {
        // ink in the very first row and column, and in the last
        let img = page(40, 20, 255, &[(0, 0, 6, 8, 0), (34, 12, 6, 8, 0)]);
        let (out, pw, ph) = padded(&img, 40, 20, PAD);
        assert_eq!((pw, ph), (40 + 2 * PAD, 20 + 2 * PAD));
        assert_eq!(out[PAD * pw + PAD], 0, "the ink moved in by the border");
        assert_eq!(out[(PAD + 19) * pw + PAD + 39], 0);
        assert!(out[..PAD * pw].iter().all(|v| *v == 255), "the border is white");
        assert!((0..ph).all(|y| out[y * pw] == 255 && out[y * pw + pw - 1] == 255));
        let p = prepare(&bgra(&img), 40, 20, 10_000, Strength::Normal);
        assert_eq!((p.w, p.h, p.pad), ((40 + 2 * PAD) * p.scale, (20 + 2 * PAD) * p.scale, PAD));
    }

    #[test]
    fn a_line_that_runs_across_table_columns_is_split_at_the_gaps() {
        let word = |text: &str, x: f32| Word { text: text.into(), x, y: 100.0, w: text.len() as f32 * 6.5, h: 11.0 };
        // "Code Hallucinations" | "Invents or assumes" | "Invents a method on a real"
        let words = vec![
            word("Code", 64.0), word("Hallucinations", 94.0),
            word("Invents", 223.0), word("or", 268.0), word("assumes", 285.0),
            word("Invents", 382.0), word("a", 428.0), word("method", 438.0), word("on", 482.0), word("a", 498.0), word("real", 508.0),
        ];
        let pieces = split_columns(&words);
        assert_eq!(pieces.iter().map(|l| l.text.as_str()).collect::<Vec<_>>(), ["Code Hallucinations", "Invents or assumes", "Invents a method on a real"]);
        assert_eq!(pieces[1].x, 223.0);
        assert!((pieces[1].w - (285.0 + 7.0 * 6.5 - 223.0)).abs() < 0.01);
        // an ordinary sentence stays one line, even with a wider space after a full stop
        let sentence = vec![word("Log", 10.0), word("an", 35.0), word("entry.", 53.0), word("Each", 104.0), word("entry", 136.0)];
        assert_eq!(split_columns(&sentence).len(), 1);
    }

    #[test]
    fn light_text_on_a_coloured_band_is_read_like_the_rest() {
        // a white page with a dark blue band (a table header) holding white letters, and black letters below it
        let img = page(96, 64, 255, &[(0, 16, 96, 16, 90), (20, 20, 3, 9, 250), (40, 20, 3, 9, 250), (20, 44, 3, 9, 0)]);
        let lum = luminance(&bgra(&img), 96, 64);
        assert!(!is_dark(&lum));
        let out = clean(&lum, 96, 64, Strength::Faint);
        assert!(out[24 * 96 + 21] < 80, "the header letter is dark: {}", out[24 * 96 + 21]);
        assert!(out[24 * 96 + 70] > 200, "the band itself is light: {}", out[24 * 96 + 70]);
        assert!(out[48 * 96 + 21] < 40, "ordinary text is still dark");
        assert_eq!(out[56 * 96 + 70], 255);
    }

    #[test]
    fn numbers_read_as_letters_are_put_right() {
        assert_eq!(fix_digits("List already full at IO"), "List already full at 10");
        assert_eq!(fix_digits("JobsState.EnsureCanStart throws at IO before anything is deleted"), "JobsState.EnsureCanStart throws at 10 before anything is deleted");
        assert_eq!(fix_digits("so the 1Ith backup, in 2O24, cost 1OO (l0 more than IOO)."), "so the 11th backup, in 2024, cost 100 (10 more than 100).");
        // real words and abbreviations stay
        assert_eq!(fix_digits("Disk I/O is slow; the IO layer and Ohio (OH) to Illinois"), "Disk I/O is slow; the IO layer and Ohio (OH) to Illinois");
        assert_eq!(fix_digits("I like it. Is it 0ecfe2fc or Io?"), "I like it. Is it 0ecfe2fc or Io?");
        assert_eq!(fix_digits("10 items, 3 left"), "10 items, 3 left");
        // two readings of one line: the one that saw the number wins for that word only
        assert_eq!(agree_on_digits("Keep IO backups and lOO logs", "Keep 10 backups and 100 1ogs"), "Keep 10 backups and 100 logs");
        assert_eq!(agree_on_digits("Keep IO backups", "Keep 10 old backups"), "Keep IO backups");
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
