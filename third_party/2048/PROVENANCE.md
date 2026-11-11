# Fixture provenance

Source: https://github.com/gabrielecirulli/2048 (master, retrieved 2026-11-11).

The HTML, main CSS, JavaScript, LICENSE.txt and README.md were retrieved from
the upstream repository via the GitHub connector. Preserve LICENSE.txt.
This is a selected-file fixture, not a complete upstream clone.

GlitchHunter added this file and `style/fonts/clear-sans.css`, a comment-only
placeholder that makes the CSS use installed system fallback fonts. Font
binaries, favicon and mobile splash/icon assets are omitted. No gameplay source
was modified. The demo's declared `seededHarness` mode replaces Math.random
at runtime to make this isolated fixture repeatable; it is instrumentation,
not a guarantee for arbitrary games, cryptographic RNG, workers or physics.

`manifest.json` records SHA-256 hashes of the exact local fixture files.
Compare it when reproducing results; branch names alone do not pin a build.
