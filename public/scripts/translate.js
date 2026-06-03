(function bootstrapSplitTranslate() {
  if (globalThis.__TRANSLATE_SPLIT_BOOTSTRAPPED__) return;
  globalThis.__TRANSLATE_SPLIT_BOOTSTRAPPED__ = true;

  var scriptHost = document.body || document.head;
  if (!scriptHost) return;

  var parts = [
    '/scripts/translate/01-state-and-boot.js',
    '/scripts/translate/02-provider-and-model-config.js',
    '/scripts/translate/03-model-loading-and-base-utils.js',
    '/scripts/translate/04-translation-quality-utils.js',
    '/scripts/translate/05-cost-and-provider-ui.js',
    '/scripts/translate/06-api-key-and-checkpoint.js',
    '/scripts/translate/07-history-and-file-loading.js',
    '/scripts/translate/08-chunking-and-runtime-controls.js',
    '/scripts/translate/08b-chapter-detection.js',
    '/scripts/translate/09a-translate-chunk.js',
    '/scripts/translate/09b-process-chunks.js',
    '/scripts/translate/09c-glossary-extraction.js',
    '/scripts/translate/10-translation-runner.js',
    '/scripts/translate/11-export-and-result.js',
    '/scripts/translate/12-ui-events-and-reset.js'
  ];

  var current = 0;
  function loadNext() {
    if (current >= parts.length) return;
    var script = document.createElement('script');
    script.src = parts[current++];
    script.async = false;
    script.onload = loadNext;
    script.onerror = function () {
      console.error('Failed to load translate part:', script.src);
    };
    scriptHost.appendChild(script);
  }

  loadNext();
})();
