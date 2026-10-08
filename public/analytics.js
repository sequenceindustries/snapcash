/* snapcash — Google Analytics 4 (G-Z700NEF7ZG).
   Only the page path (plus any utm_/gclid campaign tags) is sent to Google:
   other query strings are dropped, so things like password-reset tokens never
   leave the site. Not loaded on the admin back office or sign-in hand-off pages. */
(function () {
  var ID = 'G-Z700NEF7ZG';
  var page = location.pathname.split('/').pop() || 'index.html';
  if (/^(admin|reset|auth-callback)(\.html)?$/.test(page)) return;

  function clean(url) {
    try {
      var u = new URL(url, location.href), keep = new URLSearchParams();
      u.searchParams.forEach(function (v, k) { if (/^(utm_[a-z]+|gclid|fbclid)$/.test(k)) keep.set(k, v); });
      var qs = keep.toString();
      return u.origin + u.pathname + (qs ? '?' + qs : '');
    } catch (e) { return ''; }
  }

  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  window.gtag = gtag;
  gtag('js', new Date());
  gtag('config', ID, {
    page_location: clean(location.href),
    page_referrer: document.referrer ? clean(document.referrer) : ''
  });

  var s = document.createElement('script');
  s.async = true;
  s.src = 'https://www.googletagmanager.com/gtag/js?id=' + ID;
  document.head.appendChild(s);
})();
