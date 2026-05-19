(function bootstrapSplitWriting() {
  if (globalThis.__WRITING_SPLIT_BOOTSTRAPPED__) return;
  globalThis.__WRITING_SPLIT_BOOTSTRAPPED__ = true;

  var scriptHost = document.body || document.head;
  if (!scriptHost) return;

  var parts = [
    '/scripts/writing/01-analysis-and-prompts.js',
    '/scripts/writing/02-api-and-writing-flow.js',
    '/scripts/writing/03-writing-ui-actions.js'
  ];

  var current = 0;
  function loadNext() {
    if (current >= parts.length) return;
    var script = document.createElement('script');
    script.src = parts[current++];
    script.async = false;
    script.onload = loadNext;
    script.onerror = function () {
      console.error('Failed to load writing part:', script.src);
    };
    scriptHost.appendChild(script);
  }

  loadNext();
})();
