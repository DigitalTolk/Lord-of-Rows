//! A minimal element tree on top of quick-xml (no DTDs, no external entities).

use quick_xml::events::Event;
use quick_xml::{Reader, XmlVersion};

#[derive(Debug, Default)]
pub struct Element {
    pub name: String,
    pub attrs: Vec<(String, String)>,
    pub children: Vec<Element>,
    pub text: String,
}

impl Element {
    pub fn attr(&self, k: &str) -> Option<&str> {
        self.attrs.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str())
    }
    pub fn child(&self, name: &str) -> Option<&Element> {
        self.children.iter().find(|c| c.name == name)
    }
    pub fn child_text(&self, name: &str) -> Option<&str> {
        self.child(name).map(|c| c.text.trim()).filter(|t| !t.is_empty())
    }
    /// All descendants (depth first) named `name`.
    pub fn descendants<'a>(&'a self, name: &'a str) -> Vec<&'a Element> {
        let mut out = Vec::new();
        fn walk<'a>(e: &'a Element, name: &str, out: &mut Vec<&'a Element>) {
            for c in &e.children {
                if c.name == name {
                    out.push(c);
                }
                walk(c, name, out);
            }
        }
        walk(self, name, &mut out);
        out
    }
}

fn predefined(name: &str) -> Option<&'static str> {
    Some(match name {
        "amp" => "&",
        "lt" => "<",
        "gt" => ">",
        "quot" => "\"",
        "apos" => "'",
        _ => return None,
    })
}

fn start(e: &quick_xml::events::BytesStart<'_>) -> Result<Element, String> {
    let mut el = Element { name: e.name().as_ref().to_string(), ..Default::default() };
    for a in e.attributes() {
        let a = a.map_err(|x| x.to_string())?;
        let v = a.normalized_value(XmlVersion::Implicit1_0).map_err(|x| x.to_string())?;
        el.attrs.push((a.key.as_ref().to_string(), v.into_owned()));
    }
    Ok(el)
}

/// Parses a document and returns its root element.
pub fn parse(text: &str) -> Result<Element, String> {
    let mut r = Reader::from_str(text);
    let mut stack: Vec<Element> = vec![Element::default()];
    loop {
        match r.read_event().map_err(|e| e.to_string())? {
            Event::Start(e) => stack.push(start(&e)?),
            Event::Empty(e) => {
                let el = start(&e)?;
                stack.last_mut().ok_or("bad nesting")?.children.push(el);
            }
            Event::End(_) => {
                let el = stack.pop().ok_or("bad nesting")?;
                stack.last_mut().ok_or("unbalanced end tag")?.children.push(el);
            }
            Event::Text(t) => stack.last_mut().ok_or("bad nesting")?.text.push_str(&t.xml_content(XmlVersion::Implicit1_0)),
            Event::CData(t) => stack.last_mut().ok_or("bad nesting")?.text.push_str(&t.into_inner()),
            Event::GeneralRef(g) => {
                let s = if g.is_char_ref() {
                    g.resolve_char_ref().map_err(|e| e.to_string())?.map(String::from).unwrap_or_default()
                } else {
                    predefined(&g.into_inner()).unwrap_or("").to_string()
                };
                stack.last_mut().ok_or("bad nesting")?.text.push_str(&s);
            }
            Event::Eof => break,
            _ => {}
        }
        if stack.len() > 64 {
            return Err("document is nested too deeply".into());
        }
    }
    let mut doc = stack.pop().ok_or("empty document")?;
    if !stack.is_empty() {
        return Err("unclosed element".into());
    }
    doc.children.pop().ok_or_else(|| "empty document".into())
}

#[cfg(test)]
mod tests {
    #[test]
    fn parses_attrs_text_and_entities() {
        let d = super::parse(r#"<?xml version="1.0"?><a x="1 &amp; 2"><b>t&lt;u&#65;</b><c/></a>"#).unwrap();
        assert_eq!(d.name, "a");
        assert_eq!(d.attr("x"), Some("1 & 2"));
        assert_eq!(d.child_text("b"), Some("t<uA"));
        assert!(d.child("c").is_some());
        assert!(super::parse("<a><b></a>").is_err());
    }
}
