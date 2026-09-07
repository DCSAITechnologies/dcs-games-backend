// WCAG colour arithmetic, as a source string to evaluate INSIDE the page.
//
// It lived in test/a11y-pages.test.mjs, which measures two documents. The
// estate has 190, and the same numbers are worth having about all of them —
// but a second copy of this arithmetic is a second place for it to drift, and
// two suites disagreeing about what 4.5:1 means is worse than one suite not
// measuring it at all. So it lives here, once.
//
// Everything is computed from getComputedStyle — the values the browser says
// it is PAINTING — and never from the stylesheet's intent. A custom property
// can be overridden by a later sheet, mistyped, or shadowed by a media query,
// and only the computed value knows which of those happened.

/**
 * In-page helper source. Evaluate it before your own expression:
 *   page.eval(`${CONTRAST_HELPERS} return _scanContrast();`)
 */
export const CONTRAST_HELPERS = `
  function _srgb(c){ c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  function _lum(c){ return 0.2126*_srgb(c[0]) + 0.7152*_srgb(c[1]) + 0.0722*_srgb(c[2]); }
  function _parse(s){
    var m = /rgba?\\(([^)]+)\\)/.exec(s || "");
    if (!m) return [0, 0, 0, 0];
    var p = m[1].split(/[\\s,\\/]+/).filter(Boolean).map(Number);
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  }
  function _over(fg, bg){ var a = fg[3]; return [a*fg[0]+(1-a)*bg[0], a*fg[1]+(1-a)*bg[1], a*fg[2]+(1-a)*bg[2], 1]; }
  // A document page has nothing rendering behind it, so the chain runs all the
  // way to the root and finishes on the browser's own white canvas — which is
  // what a reader would see if every layer really were transparent.
  function _bgOf(el){
    var chain = [];
    for (var n = el; n && n.nodeType === 1; n = n.parentElement) chain.push(_parse(getComputedStyle(n).backgroundColor));
    var bg = [255, 255, 255, 1];
    for (var i = chain.length - 1; i >= 0; i--) if (chain[i][3] > 0) bg = _over(chain[i], bg);
    return bg;
  }
  function _ratio(a, b){ var l1 = _lum(a), l2 = _lum(b); return Math.round(((Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05))*100)/100; }
  function _cvis(el){
    if (!el) return false;
    var cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return false;
    var b = el.getBoundingClientRect();
    return b.width > 0 && b.height > 0;
  }
  function _cdesc(el){
    var s = el.tagName.toLowerCase();
    if (el.id) s += "#" + el.id;
    if (el.className && typeof el.className === "string") s += "." + el.className.trim().split(/\\s+/).slice(0, 2).join(".");
    return s;
  }
  // Only the text an element paints ITSELF. textContent would measure a wrapper
  // against its children's colours and score the same string twice.
  function _cown(el){
    var t = "";
    for (var i = 0; i < el.childNodes.length; i++) if (el.childNodes[i].nodeType === 3) t += el.childNodes[i].nodeValue;
    return t.trim();
  }
  function _crow(el, pseudo){
    var cs = getComputedStyle(el, pseudo || null);
    var bg = _bgOf(el);
    var text = pseudo === "::placeholder" ? (el.placeholder || "") : (_cown(el) || el.value || "");
    return {
      sel: _cdesc(el) + (pseudo || ""),
      text: String(text).trim().slice(0, 34),
      ratio: _ratio(_over(_parse(cs.color), bg), bg),
      size: parseFloat(cs.fontSize),
      weight: Number(cs.fontWeight) || 400,
      color: cs.color,
    };
  }
  function _scanContrast(){
    var out = [];
    var all = document.querySelectorAll("*");
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (/^(SCRIPT|STYLE|TITLE|META|LINK|HEAD|HTML|NOSCRIPT)$/.test(el.tagName)) continue;
      if (!_cvis(el)) continue;
      var own = _cown(el) || ((el.tagName === "INPUT" || el.tagName === "TEXTAREA") ? (el.value || "") : "");
      if (!own) continue;
      out.push(_crow(el));
    }
    // A placeholder is text a person reads. Left alone the browser paints it
    // #757575, which is why it is measured separately from the field.
    var fields = document.querySelectorAll("input,textarea");
    for (var j = 0; j < fields.length; j++) {
      if (_cvis(fields[j]) && fields[j].placeholder) out.push(_crow(fields[j], "::placeholder"));
    }
    return out;
  }
`;

/**
 * WCAG 1.4.3 (AA). 3:1 for large text — 18.66px bold or 24px — and 4.5:1 for
 * everything else. The threshold is a function of the text's OWN size and
 * weight, so it is computed per row rather than applied as one number.
 */
export function requiredRatio(row) {
  const large = row.size >= 24 || (row.size >= 18.66 && row.weight >= 700);
  return large ? 3 : 4.5;
}

/** The rows that do not clear their own threshold, worst first. */
export function belowContrastMinimum(rows) {
  return rows
    .filter((r) => Number.isFinite(r.ratio) && r.ratio < requiredRatio(r))
    .sort((a, b) => a.ratio - b.ratio)
    .map((r) => `${r.sel} "${r.text}" is ${r.ratio}:1 at ${r.size}px/${r.weight}, needs ${requiredRatio(r)}:1`);
}
