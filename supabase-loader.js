/* Snapcash — resilient Supabase library loader. */
(function () {
  var SOURCES = [
    'https://unpkg.com/@supabase/supabase-js@2/dist/umd/supabase.js',
    'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
    'https://esm.sh/@supabase/supabase-js@2?bundle'
  ];
  function loadSync(idx) {
    if (window.supabase && window.supabase.createClient) return;
    if (idx >= SOURCES.length) { window.SUPABASE_LOAD_FAILED = true; return; }
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', SOURCES[idx], false);
      xhr.send(null);
      if (xhr.status >= 200 && xhr.status < 300 && xhr.responseText) {
        var s = document.createElement('script');
        s.text = xhr.responseText;
        document.head.appendChild(s);
        if (window.supabase && window.supabase.createClient) return;
      }
    } catch (e) {}
    loadSync(idx + 1);
  }
  loadSync(0);
})();
