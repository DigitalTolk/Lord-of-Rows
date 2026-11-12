#!/usr/bin/env node
// Stands in for the system browser during E2E runs (the app honours $BROWSER on Linux):
// requests the sign-in URL and follows the provider's redirect back to the app's
// loopback listener, like a browser whose single sign-on session is already active.
const url = process.argv[2];
if (!url) process.exit(2);
fetch(url, { redirect: 'follow' })
  .then((r) => process.exit(r.ok ? 0 : 1))
  .catch(() => process.exit(1));
