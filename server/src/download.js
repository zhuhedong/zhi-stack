// Refresh the displayed version from the latest GitHub release.
// Any failure (blocked, slow, rate-limited) keeps the server-rendered value.
(function () {
  'use strict';
  var API = 'https://api.github.com/repos/zhuhedong/zhi-stack/releases/latest';
  if (!window.fetch) return;
  var ctrl = window.AbortController ? new AbortController() : null;
  var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 4000);
  fetch(API, { headers: { Accept: 'application/vnd.github+json' }, signal: ctrl ? ctrl.signal : undefined, credentials: 'omit', referrerPolicy: 'no-referrer' })
    .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(function (rel) {
      var tag = rel && typeof rel.tag_name === 'string' ? rel.tag_name.trim() : '';
      if (!/^v?\d+\.\d+\.\d+([-.+][0-9A-Za-z.-]+)?$/.test(tag) || rel.draft || rel.prerelease) return;
      var v = tag.charAt(0) === 'v' ? tag : 'v' + tag;
      document.querySelectorAll('[data-live-version]').forEach(function (el) { el.textContent = v; });
      var d = typeof rel.published_at === 'string' ? rel.published_at.slice(0, 10) : '';
      if (/^\d{4}-\d{2}-\d{2}$/.test(d)) document.querySelectorAll('[data-live-date]').forEach(function (el) { el.textContent = d + ' 发布'; });
      var u = typeof rel.html_url === 'string' ? rel.html_url : '';
      if (u.indexOf('https://github.com/zhuhedong/zhi-stack/releases/') === 0) document.querySelectorAll('[data-live-notes]').forEach(function (el) { el.href = u; });
    })
    .catch(function () {})
    .then(function () { clearTimeout(timer); });
})();
