//! Example DB Studio plugin: uppercases SQL keywords in place.
//!
//! `no_std`, no allocator, no imports. The host copies the SQL into a buffer
//! returned by `alloc`, calls `format_sql(ptr, len)` and reads the result back
//! from `(ptr << 32) | len`. Uppercasing ASCII keywords never changes the
//! length, so the input buffer is rewritten in place.
#![no_std]

use core::arch::wasm32;

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    wasm32::unreachable()
}

const PAGE: usize = 65536;

/// Grows memory by enough fresh pages for `len` bytes and returns their start.
/// Each call to the plugin gets a new instance, so nothing is ever freed.
#[no_mangle]
pub extern "C" fn alloc(len: i32) -> i32 {
    let pages = (len.max(1) as usize).div_ceil(PAGE);
    let old = wasm32::memory_grow(0, pages);
    if old == usize::MAX {
        wasm32::unreachable();
    }
    (old * PAGE) as i32
}

#[no_mangle]
pub extern "C" fn dealloc(_ptr: i32, _len: i32) {}

fn is_keyword(w: &[u8]) -> bool {
    // Lowercase into a small buffer, then let the compiler build a matcher:
    // much cheaper per word than scanning a keyword list (plugins pay fuel per instruction).
    let mut buf = [0u8; 10];
    if w.len() > buf.len() {
        return false;
    }
    for (d, s) in buf.iter_mut().zip(w) {
        *d = s.to_ascii_lowercase();
    }
    matches!(
        &buf[..w.len()],
        b"add" | b"all" | b"alter" | b"and" | b"any" | b"as" | b"asc" | b"begin" | b"between" | b"by" | b"case" | b"cast" | b"check" | b"column"
            | b"commit" | b"constraint" | b"create" | b"cross" | b"default" | b"delete" | b"desc" | b"distinct" | b"drop" | b"else" | b"end"
            | b"except" | b"exists" | b"explain" | b"foreign" | b"from" | b"full" | b"group" | b"having" | b"if" | b"in" | b"index" | b"inner"
            | b"insert" | b"intersect" | b"into" | b"is" | b"join" | b"key" | b"left" | b"like" | b"limit" | b"not" | b"null" | b"offset" | b"on"
            | b"or" | b"order" | b"outer" | b"primary" | b"references" | b"returning" | b"right" | b"rollback" | b"select" | b"set" | b"table"
            | b"then" | b"union" | b"unique" | b"update" | b"using" | b"values" | b"view" | b"when" | b"where" | b"with"
    )
}

fn is_word(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'$'
}

fn uppercase_keywords(s: &mut [u8]) {
    let n = s.len();
    let mut i = 0;
    while i < n {
        let c = s[i];
        match c {
            // Quoted text: skip to the matching close quote (doubled quote = escape).
            b'\'' | b'"' | b'`' => {
                i += 1;
                while i < n {
                    if s[i] == c {
                        if i + 1 < n && s[i + 1] == c {
                            i += 2;
                            continue;
                        }
                        break;
                    }
                    i += 1;
                }
                i += 1;
            }
            b'-' if i + 1 < n && s[i + 1] == b'-' => {
                while i < n && s[i] != b'\n' {
                    i += 1;
                }
            }
            b'/' if i + 1 < n && s[i + 1] == b'*' => {
                i += 2;
                while i + 1 < n && !(s[i] == b'*' && s[i + 1] == b'/') {
                    i += 1;
                }
                i += 2;
            }
            _ if is_word(c) => {
                let start = i;
                while i < n && is_word(s[i]) {
                    i += 1;
                }
                // `t.select` is a column, not a keyword.
                let qualified = start > 0 && s[start - 1] == b'.';
                if !qualified && is_keyword(&s[start..i]) {
                    s[start..i].make_ascii_uppercase();
                }
            }
            _ => i += 1,
        }
    }
}

/// # Safety
/// The host guarantees `ptr..ptr+len` is the buffer it obtained from `alloc`.
#[no_mangle]
pub unsafe extern "C" fn format_sql(ptr: i32, len: i32) -> i64 {
    let buf = core::slice::from_raw_parts_mut(ptr as usize as *mut u8, len as usize);
    uppercase_keywords(buf);
    ((ptr as u32 as i64) << 32) | len as u32 as i64
}
